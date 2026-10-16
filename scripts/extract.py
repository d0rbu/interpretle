"""Compute actual layer-21 SAE and neuron activations once, offline.

The cache contains complete source documents, tokenizer offsets, and sparse SAE
values. Nothing in this script runs on the website's server.
"""

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from safetensors import safe_open
from transformers import AutoModelForCausalLM, AutoTokenizer


CONFIG = json.loads((Path(__file__).resolve().parents[1] / 'data/model.json').read_text())
MODEL, REVISION = CONFIG['model'], CONFIG['model_revision']
SAE, SAE_REVISION, SAE_ID = CONFIG['sae'], CONFIG['sae_revision'], CONFIG['sae_id']


def load_scorer(feature_count=2048):
    torch.set_float32_matmul_precision('highest')
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL, revision=REVISION, dtype=torch.float16,
        device_map="cuda", attn_implementation="sdpa",
    ).eval()
    # Locate the text decoder explicitly; avoid guessing hidden-state indices.
    names = dict(model.named_modules())
    hook_name = "model.language_model.layers.21"
    if hook_name in names:
        text_model = names["model.language_model"]
    elif "model.layers.21" in names:
        # Transformers' text-only AutoModel wrapper removes language_model.
        hook_name = "model.layers.21"
        text_model = names["model"]
    else:
        raise ValueError("The checkpoint did not expose the expected layer-21 decoder.")
    captured = []
    hook = names[hook_name].register_forward_hook(lambda _m, _i, output: captured.append(output.detach()))
    probe = tokenizer("The ship entered the harbor. A small test of the model.", return_tensors="pt").to("cuda")
    with torch.inference_mode():
        text_model(**probe, use_cache=False)
    reference = captured.pop()
    hook.remove()
    # Later layers and the final norm cannot affect this earlier activation.
    text_model.layers = torch.nn.ModuleList(list(text_model.layers[:22]))
    text_model.norm = torch.nn.Identity()
    with torch.inference_mode():
        prefix = text_model(**probe, use_cache=False).last_hidden_state
    torch.testing.assert_close(prefix, reference, rtol=0, atol=0)
    del model, reference, prefix, probe
    torch.cuda.empty_cache()
    path = hf_hub_download(SAE, f"{SAE_ID}/sae_weights.safetensors", revision=SAE_REVISION)
    with safe_open(path, framework="pt", device="cpu") as file:
        encoder = file.get_slice("W_enc")[:, :feature_count].contiguous().cuda()
        bias = file.get_tensor("b_enc")[:feature_count].cuda()
        threshold = file.get_tensor("threshold")[:feature_count].cuda()
        input_bias = file.get_tensor("b_dec").cuda()
    return tokenizer, text_model, (encoder, bias, threshold, input_bias), hook_name


def encode(hidden, weights):
    encoder, bias, threshold, input_bias = weights
    pre = (hidden.float() - input_bias) @ encoder + bias
    return pre.relu() * (pre > threshold)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=Path("artifacts/corpus.jsonl"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/activations"))
    parser.add_argument("--features", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--neurons", type=int, nargs="*", default=[100, 500, 1000, *range(0, 2560, 160)])
    args = parser.parse_args()
    if not 1 <= args.features <= 65536:
        parser.error("--features must be between 1 and 65536")
    if any(index < 0 or index >= 2560 for index in args.neurons):
        parser.error("--neurons must be layer-21 residual coordinates from 0 to 2559")
    args.output.mkdir(parents=True, exist_ok=True)
    docs = [json.loads(line) for line in args.corpus.read_text().splitlines()]
    # Interleave sources so a bounded discovery run has the same broad mix.
    groups = {}
    for doc in docs:
        groups.setdefault(doc["source"]["kind"], []).append(doc)
    docs = [group[i] for i in range(max(map(len, groups.values()))) for group in groups.values() if i < len(group)]
    if args.limit:
        docs = docs[:args.limit]
    tokenizer, model, weights, hook_name = load_scorer(args.features)
    special = set(tokenizer.all_special_ids)
    prepared = []
    for doc in docs:
        encoded = tokenizer(doc["text"], add_special_tokens=False, return_offsets_mapping=True)
        ids = [tokenizer.bos_token_id, *encoded["input_ids"]]
        offsets = [(0, 0), *encoded["offset_mapping"]]
        if len(ids) > 1024:
            raise ValueError(f"Unexpected context overflow: {doc['id']}")
        prepared.append({**doc, "ids": ids, "offsets": offsets})
    # Similar lengths share batches; padding never contributes to stored scores.
    prepared.sort(key=lambda doc: len(doc["ids"]))
    manifest = {
        "model": MODEL, "model_revision": REVISION, "sae": SAE,
        "sae_revision": SAE_REVISION, "sae_id": SAE_ID, "hook": hook_name,
        "dtype": "float16", "sae_dtype": "float32", "features": args.features,
        "neurons": args.neurons, "documents": len(prepared),
        "context": "complete-source-document", "bos": tokenizer.bos_token_id,
        "corpus_sha256": hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
        "prefix_parity": "exact against full-model layer-21 hook",
        "versions": {"torch": torch.__version__, "transformers": __import__("transformers").__version__},
    }
    manifest_path = args.output / "manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError("Output cache belongs to a different extraction; choose a new directory.")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    started, tokens = time.monotonic(), 0
    with (args.output / "documents.jsonl").open("w") as file:
        for index, doc in enumerate(prepared):
            file.write(json.dumps({**doc, "index": index}, ensure_ascii=False) + "\n")
    for first in range(0, len(prepared), args.batch_size):
        batch = prepared[first:first + args.batch_size]
        if all((args.output / f"{first + i:06d}.npz").exists() for i in range(len(batch))):
            continue
        length = max(len(doc["ids"]) for doc in batch)
        input_ids = torch.full((len(batch), length), tokenizer.pad_token_id, dtype=torch.long, device="cuda")
        attention_mask = torch.zeros_like(input_ids)
        for i, doc in enumerate(batch):
            input_ids[i, :len(doc["ids"])] = torch.tensor(doc["ids"], device="cuda")
            attention_mask[i, :len(doc["ids"])] = 1
        with torch.inference_mode():
            hidden = model(input_ids=input_ids, attention_mask=attention_mask, use_cache=False).last_hidden_state
            if not torch.isfinite(hidden).all():
                raise ValueError("Non-finite model activations.")
            for i, doc in enumerate(batch):
                count = len(doc["ids"])
                acts = encode(hidden[i, :count], weights)
                eligible = torch.tensor([token not in special and end > start for token, (start, end) in zip(doc["ids"], doc["offsets"])], device="cuda")
                acts[~eligible] = 0
                rows, columns = acts.nonzero(as_tuple=True)
                indptr = np.r_[0, np.cumsum(np.bincount(rows.cpu().numpy(), minlength=count))].astype(np.int32)
                destination = args.output / f"{first + i:06d}.npz"
                temporary = destination.with_suffix('.tmp.npz')
                np.savez_compressed(
                    temporary,
                    indptr=indptr, indices=columns.cpu().numpy().astype(np.uint16),
                    values=acts[rows, columns].cpu().numpy(),
                    neurons=hidden[i, :count, args.neurons].float().cpu().numpy(),
                    eligible=eligible.cpu().numpy(),
                )
                temporary.replace(destination)
                tokens += count
        if first % (args.batch_size * 20) == 0 or first + len(batch) == len(prepared):
            elapsed = time.monotonic() - started
            print(json.dumps({"documents": first + len(batch), "total": len(prepared), "tokens_per_second": round(tokens / max(elapsed, 1)), "seconds": round(elapsed)}), flush=True)
    print("Extraction complete.", flush=True)


if __name__ == "__main__":
    torch.set_num_threads(8)
    main()

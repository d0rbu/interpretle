"""Export small ONNX graphs and only the weights needed through layer 21.

Weights are graph inputs so the browser can run one layer at a time. This avoids
loading the entire model into GPU or WebAssembly memory. No generation head,
later decoder layers, or multimodal encoders are needed for layer 21.
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path

import onnx
import torch
from huggingface_hub import hf_hub_download
from safetensors import safe_open
from transformers import AttentionInterface, AutoConfig, AutoTokenizer
from transformers.models.gemma4.modeling_gemma4 import (
    Gemma4RMSNorm, Gemma4TextDecoderLayer, Gemma4TextRotaryEmbedding, eager_attention_forward,
)

from extract import MODEL, REVISION, SAE, SAE_ID, SAE_REVISION
from quantization import pack_fp4
from browser_assets import host_assets

PREFIX = "model.language_model."
MAX_TOKENS = 512


def header(path):
    with open(path, "rb") as file:
        size = struct.unpack("<Q", file.read(8))[0]
        data = json.loads(file.read(size))
    return {name: {"shape": row["shape"], "dtype": row["dtype"],
                   "offset": row["data_offsets"][0] + size + 8,
                   "bytes": row["data_offsets"][1] - row["data_offsets"][0]}
            for name, row in data.items() if name != "__metadata__"}


class Embeddings(torch.nn.Module):
    def __init__(self, config):
        super().__init__()
        self.per_layer_model_projection = torch.nn.Linear(2560, 22 * 256, bias=False)
        self.per_layer_projection_norm = Gemma4RMSNorm(256, eps=config.rms_norm_eps)

    def forward(self, token_rows, layer_rows):
        hidden = token_rows * torch.tensor(2560 ** 0.5, dtype=token_rows.dtype)
        lookup = (layer_rows * 16).reshape(1, -1, 22, 256)
        projected = self.per_layer_model_projection(hidden) * (2560 ** -0.5)
        projected = self.per_layer_projection_norm(projected.reshape(1, -1, 22, 256))
        return hidden, (projected + lookup) * (2 ** -0.5)


class FloatActivation(torch.nn.Module):
    def __init__(self, activation):
        super().__init__()
        self.activation = activation

    def forward(self, value):
        # Native half-precision GELU computes its intermediates in FP32. Avoid
        # rounding every decomposed ONNX arithmetic operation back to FP16.
        return self.activation(value.float()).to(value.dtype)


def float_attention(module, query, key, value, mask, **kwargs):
    # Match the FP32 reductions inside native scaled-dot-product attention.
    output, weights = eager_attention_forward(module, query.float(), key.float(), value.float(), mask, **kwargs)
    return output.to(query.dtype), weights


class Layer(torch.nn.Module):
    def __init__(self, config, index):
        super().__init__()
        self.layer = Gemma4TextDecoderLayer(config, index)
        self.layer.mlp.act_fn = FloatActivation(self.layer.mlp.act_fn)
        self.layer.act_fn = FloatActivation(self.layer.act_fn)
        self.layer.mlp.down_proj.register_forward_pre_hook(self.capture_mlp)

    def capture_mlp(self, _module, inputs):
        self.mlp_neurons = inputs[0]

    def forward(self, hidden, per_layer, cosine, sine, mask):
        output = self.layer(hidden, per_layer, shared_kv_states={},
                            position_embeddings=(cosine, sine), attention_mask=mask)
        return output, self.mlp_neurons


def export(module, inputs, input_names, output_names, path, axes, checkpoint_names):
    module.eval()
    with torch.inference_mode():
        torch.onnx.export(module, inputs, str(path), export_params=False,
                          input_names=input_names, output_names=output_names,
                          dynamic_axes=axes, opset_version=17, dynamo=False,
                          do_constant_folding=False, external_data=False)
    graph = onnx.load(path)
    # WebGPU's unquantized FP16 MatMul accumulates in FP16 on some devices.
    # Keep weights/hidden states in FP16, but accumulate dot products in FP32,
    # then round once, as in the native CUDA model.
    inferred = onnx.shape_inference.infer_shapes(graph)
    types = {item.name: item.type.tensor_type.elem_type
             for item in [*inferred.graph.input, *inferred.graph.value_info, *inferred.graph.output]}
    nodes = []
    for node in graph.graph.node:
        if node.op_type == 'MatMul' and types[node.output[0]] == onnx.TensorProto.FLOAT16:
            for index, name in enumerate(node.input):
                promoted = f'{node.name}_input_{index}_fp32'
                nodes.append(onnx.helper.make_node('Cast', [name], [promoted], to=onnx.TensorProto.FLOAT))
                node.input[index] = promoted
            output = node.output[0]
            node.output[0] = output + '_fp32'
            nodes.append(node)
            nodes.append(onnx.helper.make_node('Cast', [node.output[0]], [output], to=onnx.TensorProto.FLOAT16))
        else:
            nodes.append(node)
    del graph.graph.node[:]
    graph.graph.node.extend(nodes)
    onnx.checker.check_model(graph)
    onnx.save(graph, path)
    if graph.graph.initializer:
        raise ValueError("Expected weights as inputs, not embedded initializers.")
    weights = {}
    for item in graph.graph.input:
        if item.name not in input_names:
            if item.name not in checkpoint_names:
                raise ValueError(f"Unmapped graph input: {item.name}")
            weights[item.name] = checkpoint_names[item.name]
    return {"url": f"/model/{path.name}", "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "weights": weights}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("public/model"))
    parser.add_argument('--fp4', action='store_true', help='Approximate browser weights; offline scores remain unchanged.')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    config = AutoConfig.from_pretrained(MODEL, revision=REVISION).text_config
    if MAX_TOKENS > config.sliding_window:
        raise ValueError('Browser inputs must fit within the sliding attention window.')
    AttentionInterface.register('interpretle_export', float_attention)
    config._attn_implementation = 'interpretle_export'
    checkpoint = hf_hub_download(MODEL, "model.safetensors", revision=REVISION)
    sae_checkpoint = hf_hub_download(SAE, f"{SAE_ID}/sae_weights.safetensors", revision=SAE_REVISION)
    tensors = header(checkpoint)
    graphs = {}
    length = 8
    with safe_open(checkpoint, framework="pt", device="cpu") as file:
        with torch.device("meta"):
            embedding = Embeddings(config)
        state = {name: file.get_tensor(PREFIX + name)[:22 * 256].half() for name in embedding.state_dict()}
        embedding.load_state_dict(state, assign=True)
        graphs["embedding"] = export(
            embedding, (torch.zeros(1, length, 2560).half(), torch.zeros(1, length, 22 * 256).half()),
            ["token_rows", "layer_rows"], ["hidden", "per_layer"], args.output / "embedding-v2.onnx",
            {name: {1: "sequence"} for name in ["token_rows", "layer_rows", "hidden", "per_layer"]},
            {name: PREFIX + name for name in embedding.state_dict()},
        )
        del embedding, state
        rotary = Gemma4TextRotaryEmbedding(config)
        positions = torch.arange(MAX_TOKENS).unsqueeze(0)
        positional = {}
        for kind, index in [("sliding", 0), ("full", 5)]:
            cosine, sine = rotary(torch.zeros(1, MAX_TOKENS, 2560).half(), positions, kind + "_attention")
            for label, value in [("cosine", cosine), ("sine", sine)]:
                path = args.output / f"{kind}-{label}.bin"
                path.write_bytes(value.numpy().tobytes())
                positional[f"{kind}_{label}"] = {"url": f"/model/{path.name}", "shape": list(value.shape),
                                                   "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            with torch.device("meta"):
                module = Layer(config, index)
            mapping = {name: PREFIX + f"layers.{index}." + name.removeprefix("layer.")
                       for name in module.state_dict()}
            module.load_state_dict({name: file.get_tensor(original).half() for name, original in mapping.items()}, assign=True)
            mask = torch.triu(torch.full((1, 1, length, length), -65504, dtype=torch.float16), diagonal=1)
            graphs[kind] = export(
                module, (torch.zeros(1, length, 2560).half(), torch.zeros(1, length, 256).half(),
                         cosine[:, :length], sine[:, :length], mask),
                ["hidden", "per_layer", "cosine", "sine", "mask"], ["output", "mlp"], args.output / f"{kind}-v2.onnx",
                {**{name: {1: "sequence"} for name in ["hidden", "per_layer", "cosine", "sine", "output", "mlp"]},
                 "mask": {2: "sequence", 3: "sequence"}}, mapping,
            )
            # Each layer has its own parameters, but only two graph shapes.
            graphs[kind]["weights"] = {name: original.replace(f"layers.{index}.", "layers.{layer}.")
                                       for name, original in graphs[kind]["weights"].items()}
            del module

    required = {PREFIX + "embed_tokens.weight", PREFIX + "embed_tokens_per_layer.weight"}
    required.update(graphs["embedding"]["weights"].values())
    layers = ["full" if config.layer_types[i] == "full_attention" else "sliding" for i in range(22)]
    for index, kind in enumerate(layers):
        required.update(name.replace("{layer}", str(index)) for name in graphs[kind]["weights"].values())
    selected = {name: tensors[name] for name in sorted(required)}
    # Projection rows are a contiguous prefix in the original checkpoint.
    projection = selected[PREFIX + 'per_layer_model_projection.weight']
    projection['shape'][0] = 22 * 256
    projection['bytes'] = 22 * 256 * 2560 * 2
    # Embedding columns are interleaved by vocabulary row. Repack just these
    # columns into small static assets instead of downloading unused layers.
    table = selected[PREFIX + 'embed_tokens_per_layer.weight']
    table['shape'][1] = 22 * 256
    table['bytes'] = table['shape'][0] * 22 * 256 * 2
    local_chunks = {}
    directory = args.output / 'weights'
    directory.mkdir(exist_ok=True)
    with safe_open(checkpoint, framework='pt', device='cpu') as file:
        for name, row in selected.items():
            quantized = args.fp4 and len(row['shape']) == 2
            if row is not table and not quantized:
                continue
            width = row['shape'][1]
            row_bytes = width * 18 // 32 if quantized else width * 2
            if quantized:
                assert width % 32 == 0
                row['dtype'] = 'FP4'
                row['bytes'] = row['shape'][0] * row_bytes
            chunks = local_chunks[name] = []
            tensor = file.get_slice(name)
            rows_per_chunk = (16 * 1024 * 1024) // row_bytes
            for first in range(0, row['shape'][0], rows_per_chunk):
                values = tensor[first:min(first + rows_per_chunk, row['shape'][0]), :width].contiguous()
                data = (pack_fp4(values.to(device='cuda' if torch.cuda.is_available() else 'cpu', dtype=torch.float16))
                        if quantized else values.view(torch.uint16).numpy().tobytes())
                digest = hashlib.sha256(data).hexdigest()
                path = directory / f'{digest}.bin'
                path.write_bytes(data)
                chunks.append(dict(offset=row['offset'] + first * row_bytes, bytes=len(data),
                                   sha256=digest, url=f'/model/weights/{path.name}'))
            print(json.dumps({'tensor': name, 'dtype': row['dtype'], 'bytes': row['bytes']}), flush=True)
    # Chunk boundaries do not depend on a player's input. Download the entire
    # fixed selection before looking up token rows, so requests reveal no text.
    sources = {
        "model": {"url": f"https://huggingface.co/{MODEL}/resolve/{REVISION}/model.safetensors", "tensors": selected},
    }
    for source in sources.values():
        source["chunks"] = []
        with open(checkpoint, "rb") as file:
            for name, row in sorted(source["tensors"].items(), key=lambda item: item[1]['offset']):
                if name in local_chunks:
                    source['chunks'].extend(local_chunks[name])
                    continue
                for start in range(row["offset"], row["offset"] + row["bytes"], 16 * 1024 * 1024):
                    size = min(16 * 1024 * 1024, row["offset"] + row["bytes"] - start)
                    file.seek(start)
                    source["chunks"].append({"offset": start, "bytes": size, "sha256": hashlib.sha256(file.read(size)).hexdigest()})
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
    with safe_open(sae_checkpoint, framework="pt", device="cpu") as file:
        input_bias = file.get_tensor("b_dec").tolist()
    manifest = {"version": f"gemma4-e4b-l21-{REVISION[:12]}-v2{'-fp4' if args.fp4 else ''}", "maxTokens": MAX_TOKENS,
                'precision': 'FP4 E2M1, block 32, FP16 scales and compute' if args.fp4 else 'original weights, FP16 compute',
                "bos": tokenizer.bos_token_id, "specialIds": tokenizer.all_special_ids,
                "tokenizer": {name: f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}.json"
                              for name in ["tokenizer", "tokenizer_config"]},
                "graphs": graphs, "positions": positional, "layers": layers, "sources": sources,
                "sae": {"repository": SAE, "revision": SAE_REVISION, "id": SAE_ID, "inputBias": input_bias},
                "bytes": sum(chunk["bytes"] for source in sources.values() for chunk in source["chunks"])}
    # Old open tabs still use the original manifest and graph URLs.
    manifest = host_assets(manifest, args.output, checkpoint, sae_checkpoint)
    manifest_path = args.output / f"manifest-v3{'-fp4' if args.fp4 else ''}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    catalog_path = Path('public/puzzles/index.json')
    if catalog_path.exists() and args.output.resolve() == Path('public/model').resolve():
        catalog = json.loads(catalog_path.read_text())
        catalog['browserModel'] = dict(manifest=f'/model/{manifest_path.name}', bytes=manifest['bytes'], approximate=args.fp4)
        catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    print(json.dumps({"bytes": manifest["bytes"], "graphs": list(graphs), "layers": len(layers)}), flush=True)


if __name__ == "__main__":
    torch.set_num_threads(8)
    main()

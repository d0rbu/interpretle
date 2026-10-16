"""Measure model and encoder FP8/FP4 error against native activation scores.

Both formats use blocks of 32 weights and an FP16 scale, with FP16 compute.
This is an offline experiment, not a browser fallback or a new scoring model.
Model trials retain the FP32 encoder; encoder-only trials retain native model
outputs. Normalization vectors, biases and thresholds are never quantized.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import hf_hub_download

from build_puzzles import spans
from extract import MODEL, REVISION, encode, load_scorer
from verify_model import TEXTS
from quantization import roundtrip, quantize_model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=Path('artifacts/corpus.jsonl'))
    parser.add_argument('--output', type=Path, default=Path('artifacts/precision'))
    parser.add_argument('--per-source', type=int, default=30)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    groups = {}
    for line in args.corpus.read_text().splitlines():
        doc = json.loads(line)
        groups.setdefault(doc['source']['kind'], []).append(doc)
    cases = [dict(id=f'reference-{i}', text=text) for i, text in enumerate(TEXTS)]
    for group in groups.values():
        for i in np.linspace(0, len(group) - 1, min(args.per_source, len(group)), dtype=int):
            cases.append(group[i])
    packs = [json.loads(p.read_text()) for p in sorted(Path('public/puzzles').glob('gemma4-l21-sae-*-v1.json'))]
    # Include the complete source documents behind every published winning
    # example, so the test actually probes the game's 99.9% decision boundary.
    winning_docs = {p['id'].rsplit(':', 1)[0] for pack in packs for p in pack['passages'] if p['band'] == 99.9}
    selected = {case['id'] for case in cases}
    for group in groups.values():
        cases.extend(doc for doc in group if doc['id'] in winning_docs and doc['id'] not in selected)
    tokenizer, model, encoder, hook = load_scorer()
    mlp = []
    indices = list(range(0, 10240, 80))
    def capture(_module, inputs):
        mlp[:] = [inputs[0][..., indices].detach()]
    handle = model.layers[21].mlp.down_proj.register_forward_pre_hook(capture)
    prepared, reference = [], []
    with torch.inference_mode():
        for case in cases:
            encoded = tokenizer(case['text'], return_tensors='pt', return_offsets_mapping=True)
            offsets = encoded.pop('offset_mapping')[0].tolist()
            hidden = model(**encoded.to('cuda'), use_cache=False).last_hidden_state[0]
            eligible = ~torch.isin(encoded['input_ids'][0, 1:], torch.tensor(tokenizer.all_special_ids, device='cuda'))
            prepared.append((encoded, list(spans(dict(text=case['text'], offsets=offsets))), eligible))
            reference.append((hidden.cpu(), mlp[0][0].float().cpu()))
    print(json.dumps({'stage': 'reference', 'cases': len(cases), 'tokens': sum(len(h) - 1 for h, _ in reference)}), flush=True)
    checkpoint = hf_hub_download(MODEL, 'model.safetensors', revision=REVISION)
    report = dict(model=MODEL, revision=REVISION, hook=hook, sae_features=65536,
                  device=torch.cuda.get_device_name(), corpus_sha256=hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
                  cases=[c['id'] for c in cases], tokens=sum(len(h) - 1 for h, _ in reference),
                  calibration_targets=[p['id'] for p in packs],
                  formats={}, contract='block 32, FP16 scale; model weights with FP16 compute or encoder weights with FP32 compute; unchanged biases and thresholds')
    for trial in ['model-fp8', 'model-fp4', 'encoder-fp8', 'encoder-fp4']:
        component, precision = trial.split('-')
        active_encoder = encoder
        # Always restore from the pinned checkpoint; never quantize a previous trial.
        count = 0
        with torch.inference_mode():
            if component == 'model':
                count = quantize_model(model, checkpoint, precision)
            else:
                quantized = torch.empty_like(encoder[0])
                for first in range(0, 65536, 1024):
                    # Each encoder vector gets its own contiguous blocks.
                    quantized[:, first:first + 1024] = roundtrip(encoder[0][:, first:first + 1024].T.contiguous(), precision).T
                active_encoder = (quantized, *encoder[1:])
                count = quantized.numel()
        print(json.dumps({'stage': 'quantized', 'trial': trial, 'weights': count}), flush=True)
        squared_error = squared_reference = mlp_error = mlp_reference = 0.
        true_positive = false_positive = false_negative = 0
        percentile_errors, active_errors, passage_maxima, reference_maxima = [], [], [], []
        reference_wins = false_wins = missed_wins = 0
        with torch.inference_mode():
            for i, ((encoded, windows, eligible), (baseline, baseline_mlp)) in enumerate(zip(prepared, reference)):
                hidden = model(**encoded, use_cache=False).last_hidden_state[0] if component == 'model' else baseline.cuda()
                expected, actual = encode(baseline.cuda(), encoder)[1:], encode(hidden, active_encoder)[1:]
                expected[~eligible] = 0
                actual[~eligible] = 0
                squared_error += float((actual - expected).square().sum())
                squared_reference += float(expected.square().sum())
                positive, observed = expected > 0, actual > 0
                true_positive += int((positive & observed).sum())
                false_positive += int((~positive & observed).sum())
                false_negative += int((positive & ~observed).sum())
                target_mlp = baseline_mlp[1:].cuda().clamp_min(0)
                actual_mlp = mlp[0][0, 1:].float().clamp_min(0) if component == 'model' else target_mlp
                mlp_error += float((actual_mlp[eligible] - target_mlp[eligible]).square().sum())
                mlp_reference += float(target_mlp[eligible].square().sum())
                for first, last, _, _ in windows:
                    expected_max = expected[first - 1:last - 1].amax(dim=0).cpu().numpy()
                    actual_max = actual[first - 1:last - 1].amax(dim=0).cpu().numpy()
                    reference_maxima.append(expected_max)
                    passage_maxima.append(actual_max)
                    for pack in packs:
                        population = np.asarray(pack['reference'])
                        a, b = expected_max[pack['index']], actual_max[pack['index']]
                        before, after = [0 if value <= 0 else 100 * np.searchsorted(population, value, side='left') / len(population) for value in [a, b]]
                        percentile_errors.append(abs(before - after))
                        if a > 0 or b > 0:
                            active_errors.append(abs(before - after))
                        reference_wins += before >= 99.9
                        false_wins += before < 99.9 <= after
                        missed_wins += after < 99.9 <= before
                if (i + 1) % 16 == 0:
                    print(json.dumps({'trial': trial, 'cases': i + 1}), flush=True)
        np.savez_compressed(args.output / f'{trial}-maxima.npz', expected=np.asarray(reference_maxima), actual=np.asarray(passage_maxima))
        result = dict(sae_relative_l2=(squared_error / squared_reference) ** .5,
                      activation_precision=true_positive / (true_positive + false_positive),
                      activation_recall=true_positive / (true_positive + false_negative),
                      activation_false_positives=false_positive, activation_false_negatives=false_negative,
                      mlp_relative_l2=(mlp_error / mlp_reference) ** .5,
                      percentile_error_median=float(np.median(percentile_errors)),
                      percentile_error_p95=float(np.percentile(percentile_errors, 95)),
                      percentile_error_max=float(max(percentile_errors)),
                      active_percentile_error_median=float(np.median(active_errors)),
                      active_percentile_error_p95=float(np.percentile(active_errors, 95)),
                      reference_wins=int(reference_wins), false_wins=int(false_wins), missed_wins=int(missed_wins),
                      win_changes=int(false_wins + missed_wins),
                      calibrated_passage_comparisons=len(percentile_errors))
        report['formats'][trial] = result
        (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'trial': trial, **result}), flush=True)
    handle.remove()


if __name__ == '__main__':
    torch.set_num_threads(8)
    main()

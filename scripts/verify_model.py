"""Qualify extraction and save reference activations for browser comparison."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import snapshot_download
from sae_lens import SAE

from extract import SAE as SAE_REPO, SAE_ID, SAE_REVISION, encode, load_scorer


TEXTS = [
    "The small ship entered the harbor. Its captain watched the waves break against the old stone wall.",
    "def square(x):\n    return x * x\n\nassert square(7) == 49",
    "How do I make a cup of tea? First, boil water. Then let the tea steep for a few minutes.",
    "A café in 日本 has  two  spaces, a newline\nand an unusual visitor: 🦄😁.",
    "The experiment measured electrical resistance as the temperature increased from 20 to 80 degrees Celsius.",
    "He said, \"I don't think that is right.\" She replied, \"Let's check the evidence together.\"",
    "There were 17 red balls and 23 blue balls in the box, for a total of 40 balls.",
    "In 1969, the Apollo 11 astronauts landed on the Moon. Armstrong and Aldrin explored its surface.",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('artifacts/validation'))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    tokenizer, model, weights, hook = load_scorer()
    report = {'hook': hook, 'prefix_parity': 'exact', 'cases': [], 'native_sae_max_error': 0}
    sae_root = snapshot_download(SAE_REPO, revision=SAE_REVISION, allow_patterns=[f'{SAE_ID}/*'])
    native = SAE.load_from_disk(Path(sae_root) / SAE_ID, device='cuda').eval()
    selected = set()
    with torch.inference_mode():
        for index, text in enumerate(TEXTS):
            encoded = tokenizer(text, return_tensors='pt', return_offsets_mapping=True)
            offsets = encoded.pop('offset_mapping')[0].tolist()
            hidden = model(**encoded.to('cuda'), use_cache=False).last_hidden_state[0]
            actual = encode(hidden, weights)
            expected = native.encode(hidden.float())[:, :actual.shape[1]]
            difference = (actual - expected).abs()
            torch.testing.assert_close(actual, expected, rtol=1e-5, atol=1e-4)
            if not torch.equal(actual > 0, expected > 0):
                raise ValueError('Native SAE activation masks differ.')
            report['native_sae_max_error'] = max(report['native_sae_max_error'], float(difference.max()))
            np.savez_compressed(args.output / f'case-{index}.npz', hidden=hidden.cpu().numpy(),
                                activations=actual.cpu().numpy())
            order = actual[1:].amax(dim=0).argsort(descending=True).tolist()
            column = next(column for column in order if column not in selected and int((actual[1:, column] > 0).sum()) >= 2)
            selected.add(column)
            encoder = dict(weight=weights[0][:, column].cpu().tolist(), bias=float(weights[1][column]),
                           threshold=float(weights[2][column]))
            report['cases'].append(dict(text=text, ids=encoded['input_ids'][0].tolist(),
                                       target=dict(kind='sae', index=column, encoder=encoder),
                                       expected=actual[1:, column].cpu().tolist(),
                                       offsets=[dict(start=len(text[:start].encode('utf-16-le')) // 2,
                                                     end=len(text[:end].encode('utf-16-le')) // 2)
                                                for start, end in offsets]))
        # Right padding must not change which source tokens are measured.
        tokenizer.padding_side = 'right'
        batch = tokenizer(TEXTS[:2], padding=True, return_tensors='pt').to('cuda')
        padded = model(**batch, use_cache=False).last_hidden_state
        padding_errors = []
        for i in range(2):
            with np.load(args.output / f'case-{i}.npz') as file:
                expected = torch.from_numpy(file['hidden']).cuda()
            actual = padded[i, :len(expected)]
            torch.testing.assert_close(actual, expected, rtol=.02, atol=.05)
            padding_errors.append(float((actual - expected).abs().max()))
        report['padding_max_errors'] = padding_errors
    (args.output / 'reference.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'cases'}), flush=True)
    print(f"Saved {len(TEXTS)} measured browser reference cases.", flush=True)


if __name__ == '__main__':
    torch.set_num_threads(8)
    main()

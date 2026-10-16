"""Turn the offline activation cache into small, static game packs.

Run --discover first to inspect features, then supply a curated targets JSON file.
Percentiles always use all positive passage maxima in this fixed corpus.
"""

import argparse
import hashlib
import json
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from huggingface_hub import hf_hub_download
from safetensors import safe_open


def spans(doc):
    offsets, text = doc["offsets"], doc["text"]
    first = 1  # BOS is never displayed or scored.
    while first < len(offsets):
        last = min(first + 48, len(offsets))
        candidates = []
        for end in range(first + 20, min(first + 64, len(offsets))):
            position = offsets[end][0]
            if position and (text[position - 1] in '.!?\n' or text[position:position + 1] == '\n'):
                candidates.append(end)
        if candidates:
            last = min(candidates, key=lambda end: abs(end - first - 48))
        # Do not cut through the byte-fallback tokens of a Unicode character.
        while last < len(offsets) and offsets[last][0] < offsets[last - 1][1]:
            last += 1
        start, end = offsets[first][0], offsets[last - 1][1]
        if last - first >= 8 and end > start:
            yield first, last, start, end
        first = last


def index_cache(cache, docs, manifest):
    matrix_path, spans_path = cache / 'maxima.npy', cache / 'spans.json'
    if matrix_path.exists() and spans_path.exists():
        return np.load(matrix_path, mmap_mode='r'), json.loads(spans_path.read_text())
    rows, maxima = [], []
    for doc_index, doc in enumerate(docs):
        path = cache / f'{doc_index:06d}.npz'
        if not path.exists():
            raise ValueError(f'Extraction is incomplete: missing {path.name}')
        with np.load(path) as data:
            indptr, indices, activations = data['indptr'], data['indices'], data['values']
            neurons, eligible = data['neurons'], data['eligible']
            for first, last, start, end in spans(doc):
                values = np.zeros(manifest['features'] + len(manifest['neurons']), dtype=np.float32)
                a, b = indptr[first], indptr[last]
                np.maximum.at(values, indices[a:b], activations[a:b])
                neuron_values = neurons[first:last].copy()
                neuron_values[~eligible[first:last]] = 0
                values[manifest['features']:] = np.maximum(0, neuron_values.max(axis=0))
                rows.append([doc_index, first, last, start, end])
                maxima.append(values)
    matrix = np.asarray(maxima)
    np.save(matrix_path, matrix)
    spans_path.write_text(json.dumps(rows))
    return matrix, rows


def passage(row, column, docs, cache, manifest, band):
    doc_index, first, last, start, end = row
    doc = docs[doc_index]
    with np.load(cache / f'{doc_index:06d}.npz') as data:
        activations = np.zeros(last - first, dtype=np.float32)
        if column < manifest['features']:
            indptr, indices, values = data['indptr'], data['indices'], data['values']
            for index in range(first, last):
                a, b = indptr[index:index + 2]
                matches = indices[a:b] == column
                if np.any(matches):
                    activations[index - first] = values[a:b][matches][0]
        else:
            activations = np.maximum(0, data['neurons'][first:last, column - manifest['features']])
        eligible = data['eligible'][first:last]
    # Python offsets count code points; JavaScript string slicing counts UTF-16.
    def utf16(index):
        return len(doc['text'][start:index].encode('utf-16-le')) // 2
    tokens = [dict(id=doc['ids'][index], start=utf16(doc['offsets'][index][0]),
                   end=utf16(doc['offsets'][index][1]), activation=float(activations[index - first]))
              for index in range(first, last) if eligible[index - first]]
    return dict(id=f"{doc['id']}:{first}-{last}", text=doc['text'][start:end],
                before=doc['text'][:start], after=doc['text'][end:],
                source={key: doc['source'][key] for key in ['title', 'url', 'license']},
                tokens=tokens, band=band)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('artifacts/activations'))
    parser.add_argument('--targets', type=Path, default=Path('data/features.json'))
    parser.add_argument('--output', type=Path, default=Path('public/puzzles'))
    parser.add_argument('--discover', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((args.cache / 'manifest.json').read_text())
    docs = [json.loads(line) for line in (args.cache / 'documents.jsonl').read_text().splitlines()]
    matrix, rows = index_cache(args.cache, docs, manifest)
    if args.discover:
        candidates = []
        for column in range(matrix.shape[1]):
            values = matrix[:, column]
            count = int(np.count_nonzero(values))
            if count < min(10000, len(rows) * .1) or count > .9 * len(rows):
                continue
            top = np.argsort(values)[-6:][::-1]
            examples = []
            for index in top:
                item = passage(rows[index], column, docs, args.cache, manifest, 99.9)
                strongest = sorted(item['tokens'], key=lambda token: token['activation'], reverse=True)[:3]
                examples.append(dict(text=item['text'], maximum=float(values[index]),
                                     tokens=[dict(id=t['id'], value=t['activation']) for t in strongest]))
            candidates.append(dict(index=column, positive=count, fraction=round(count / len(rows), 3), examples=examples))
        (args.cache / 'discovery.json').write_text(json.dumps(candidates, ensure_ascii=False, indent=2))
        print(json.dumps({'passages': len(rows), 'features_to_review': len(candidates)}))
        return
    targets = json.loads(args.targets.read_text())
    row_ids = {f"{docs[doc]['id']}:{first}-{last}": i for i, (doc, first, last, _, _) in enumerate(rows)}
    sae_path = hf_hub_download(manifest['sae'], f"{manifest['sae_id']}/sae_weights.safetensors", revision=manifest['sae_revision'])
    args.output.mkdir(parents=True, exist_ok=True)
    ids, daily_ids, reports = [], [], []
    for target in targets:
        target = dict(target)
        clue = target.pop('clue', None)
        column = target['index'] if target['kind'] == 'sae' else manifest['features'] + manifest['neurons'].index(target['index'])
        values = matrix[:, column]
        reference = np.sort(values[values > 0])
        if len(reference) < 10000:
            raise ValueError(f"{target['index']}: fewer than 10,000 positive passages")
        scores = np.searchsorted(reference, values, side='left') * 100 / len(reference)
        scores[values == 0] = 0
        starter_index = int(np.argmin(np.where((values > 0) & (scores <= 50), 50 - scores, np.inf)))
        if clue:
            starter_index = row_ids[clue]
            if not 49.9 <= scores[starter_index] <= 50:
                raise ValueError(f"{target['index']}: curated clue must be between the 49.9th and 50th percentiles")
        rng = np.random.default_rng(target['index'])
        chosen = []
        counts = {}
        bands = {0: (0, 0), 50: (45, 55), 90: (88, 92), 95: (94, 96), 99: (98.5, 99.8), 99.9: (99.9, 101)}
        for band, (low, high) in bands.items():
            eligible = np.flatnonzero(values == 0) if band == 0 else np.flatnonzero((scores >= low) & (scores < high) & (values > 0))
            eligible = eligible[eligible != starter_index]
            rng.shuffle(eligible)
            # Different source documents make the options more informative.
            unique, seen = [], set()
            for index in eligible:
                doc = rows[index][0]
                text = docs[doc]['text'][rows[index][3]:rows[index][4]].strip()
                if text.startswith(('See also', 'References', 'External links')):
                    continue
                if doc not in seen:
                    seen.add(doc)
                    unique.append(index)
                if len(unique) >= (40 if band == 0 else 24):
                    break
            required = 4 if band == 99.9 else 12
            if len(unique) < required:
                raise ValueError(f"{target['index']}: band {band} has only {len(unique)} distinct documents")
            counts[str(band)] = len(unique)
            chosen.extend(passage(rows[index], column, docs, args.cache, manifest, band) for index in unique)
        identity = f"gemma4-l21-{target['kind']}-{target['index']}-v1"
        pack = dict(id=identity, **target, reference=reference.tolist(),
                    displayScale=float(reference[min(len(reference) - 1, int(np.ceil(.999 * len(reference))))]),
                    starter=passage(rows[starter_index], column, docs, args.cache, manifest, 50), passages=chosen)
        if target['kind'] == 'sae':
            with safe_open(sae_path, framework='np') as file:
                pack['encoder'] = dict(weight=file.get_slice('W_enc')[:, column:column + 1].reshape(-1).tolist(),
                                       bias=float(file.get_tensor('b_enc')[column]),
                                       threshold=float(file.get_tensor('threshold')[column]))
        content = json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + '\n'
        (args.output / f'{identity}.json').write_text(content)
        ids.append(identity)
        if target['kind'] == 'sae':
            daily_ids.append(identity)
        reports.append(dict(id=identity, positive_passages=len(reference), inactive_passages=int(np.count_nonzero(values == 0)),
                            starter_percentile=float(scores[starter_index]), bands=counts,
                            sha256=hashlib.sha256(content.encode()).hexdigest()))
    if not daily_ids:
        raise ValueError('At least one curated SAE target is required for daily puzzles.')
    first_day = date(2026, 10, 16)
    schedule = {str(first_day + timedelta(days=i)): daily_ids[i % len(daily_ids)] for i in range(90)}
    catalog_path = args.output / 'index.json'
    if catalog_path.exists():
        previous = json.loads(catalog_path.read_text())
        # Preserve already published daily assignments as the catalog expands.
        today = datetime.now(timezone.utc).date().isoformat()
        schedule.update({day: target for day, target in previous.get('daily', {}).items() if day <= today})
    catalog = dict(version='gemma4-measured-v1', firstDay=str(first_day), daily=schedule, practice=ids)
    browser_path = Path('public/model/manifest.json')
    if browser_path.exists():
        browser = json.loads(browser_path.read_text())
        catalog['browserModel'] = dict(manifest='/model/manifest.json', bytes=browser['bytes'])
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    provenance = dict(extraction=manifest, passages=len(rows), documents_by_source=dict(Counter(doc['source']['kind'] for doc in docs)),
                      sources={doc['source']['kind']: {key: doc['source'][key] for key in ['dataset', 'revision', 'license']}
                               for doc in docs},
                      scoring='strict lower rank among positive passage maxima in this fixed corpus',
                      reference_population='all non-overlapping displayed passages in the selected corpus',
                      targets=reports)
    (args.output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    main()

"""Turn the offline activation cache into small, static game packs.

Run --discover first to inspect features, then supply a curated targets JSON file.
Percentiles always use all positive passage maxima in this fixed corpus.
"""

import argparse
import hashlib
import json
import re
from collections import Counter
from array import array
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy import sparse
from huggingface_hub import hf_hub_download
from safetensors import safe_open

ENCODING_ERRORS = re.compile(r'[\u0080-\u009f\ufffd]|â€|[ÃÂ][\u0080-\u00bf]|ðŸ')
NAVIGATION = re.compile(r'^\s*(?:See also|References|External links|Further reading)\s*$', re.MULTILINE)


def context_start(doc, first):
    context_first = max(1, first - 64)
    # Keep the window within 64 tokens without starting inside a Unicode character.
    while context_first < first and doc['offsets'][context_first][0] < doc['offsets'][context_first - 1][1]:
        context_first += 1
    return doc['offsets'][context_first][0]


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
    matrix_path, spans_path = cache / 'maxima.npz', cache / 'spans.json'
    if matrix_path.exists() and spans_path.exists():
        return sparse.load_npz(matrix_path), json.loads(spans_path.read_text())
    # A dense 65k-column matrix would exceed 22 GB for this corpus. Store only
    # positive maxima and index by column for discovery and percentile ranking.
    rows, maxima, columns, pointers = [], array('f'), array('I'), array('I', [0])
    width = manifest['features'] + len(manifest['neurons']) + len(manifest.get('mlp', []))
    for doc_index, doc in enumerate(docs):
        path = cache / f'{doc_index:06d}.npz'
        if not path.exists():
            raise ValueError(f'Extraction is incomplete: missing {path.name}')
        with np.load(path) as data:
            indptr, indices, activations = data['indptr'], data['indices'], data['values']
            neurons, eligible = data['neurons'], data['eligible']
            for first, last, start, end in spans(doc):
                values = np.zeros(width, dtype=np.float32)
                a, b = indptr[first], indptr[last]
                np.maximum.at(values, indices[a:b], activations[a:b])
                neuron_values = neurons[first:last].copy()
                neuron_values[~eligible[first:last]] = 0
                neuron_end = manifest['features'] + len(manifest['neurons'])
                values[manifest['features']:neuron_end] = np.maximum(0, neuron_values.max(axis=0))
                if manifest.get('mlp'):
                    mlp_values = data['mlp'][first:last].copy()
                    mlp_values[~eligible[first:last]] = 0
                    values[neuron_end:] = np.maximum(0, mlp_values.max(axis=0))
                rows.append([doc_index, first, last, start, end])
                positive = np.flatnonzero(values).astype(np.uint32)
                columns.frombytes(positive.tobytes())
                maxima.frombytes(values[positive].tobytes())
                pointers.append(len(maxima))
        if (doc_index + 1) % 1000 == 0:
            print(json.dumps({'indexed_documents': doc_index + 1, 'passages': len(rows), 'positive_maxima': len(maxima)}), flush=True)
    matrix = sparse.csr_matrix((np.frombuffer(maxima, dtype=np.float32),
                                np.frombuffer(columns, dtype=np.uint32),
                                np.frombuffer(pointers, dtype=np.uint32)), shape=(len(rows), width)).tocsc()
    sparse.save_npz(matrix_path, matrix)
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
        elif column < manifest['features'] + len(manifest['neurons']):
            activations = np.maximum(0, data['neurons'][first:last, column - manifest['features']])
        else:
            activations = np.maximum(0, data['mlp'][first:last, column - manifest['features'] - len(manifest['neurons'])])
        eligible = data['eligible'][first:last]
    # Python offsets count code points; JavaScript string slicing counts UTF-16.
    def utf16(index):
        return len(doc['text'][start:index].encode('utf-16-le')) // 2
    tokens = [dict(id=doc['ids'][index], start=utf16(doc['offsets'][index][0]),
                   end=utf16(doc['offsets'][index][1]), activation=float(activations[index - first]))
              for index in range(first, last) if eligible[index - first]]
    return dict(id=f"{doc['id']}:{first}-{last}", text=doc['text'][start:end],
                before=doc['text'][context_start(doc, first):start],
                source={key: doc['source'][key] for key in ['title', 'url', 'license']},
                tokens=tokens, band=band)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('artifacts/activations'))
    parser.add_argument('--targets', type=Path, default=Path('data/features.json'))
    parser.add_argument('--output', type=Path, default=Path('public/puzzles'))
    parser.add_argument('--discover', action='store_true')
    parser.add_argument('--daily-only', action='store_true', help='Keep existing practice packs unchanged')
    parser.add_argument('--refresh-choices', action='store_true', help='Update reviewed suggestions, preserving every published measurement and saved passage')
    args = parser.parse_args()
    manifest = json.loads((args.cache / 'manifest.json').read_text())
    docs = [json.loads(line) for line in (args.cache / 'documents.jsonl').read_text().splitlines()]
    matrix, rows = index_cache(args.cache, docs, manifest)
    if args.discover:
        candidates = []
        for column in range(matrix.shape[1]):
            count = int(matrix.indptr[column + 1] - matrix.indptr[column])
            if count < min(10000, len(rows) * .1) or count > .9 * len(rows):
                continue
            values = matrix[:, column].toarray().ravel()
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
    # Keep the full population for calibration; only the playable excerpts
    # need to fit the card. This matches the frontend's sentence heuristic.
    showable = np.array([last - first <= 80 and
                        not ENCODING_ERRORS.search(docs[doc]['text'][context_start(docs[doc], first):end]) and
                        len(re.findall(r'''[.!?]["”’')\]]*\s+(?=\S)''', docs[doc]['text'][start:end].strip())) < 3
                        for doc, first, last, start, end in rows])
    daily_showable = showable & np.array([not NAVIGATION.search(docs[doc]['text'][start:end])
                                          for doc, _, _, start, end in rows])
    row_ids = {f"{docs[doc]['id']}:{first}-{last}": i for i, (doc, first, last, _, _) in enumerate(rows)}
    sae_path = hf_hub_download(manifest['sae'], f"{manifest['sae_id']}/sae_weights.safetensors", revision=manifest['sae_revision'])
    args.output.mkdir(parents=True, exist_ok=True)
    provenance_path = args.output / 'provenance.json'
    previous_provenance = json.loads(provenance_path.read_text()) if provenance_path.exists() else None
    catalog_path = args.output / 'index.json'
    previous = json.loads(catalog_path.read_text()) if catalog_path.exists() else {}
    published = {day: target for day, target in previous.get('daily', {}).items()
                 if day <= datetime.now(ZoneInfo('America/Los_Angeles')).date().isoformat()}
    frozen_ids = set(published.values()) | set(previous.get('practice', []))
    ids, daily_ids, reports = [], [], []
    for target in targets:
        target = dict(target)
        clue = target.pop('clue', None)
        clue_token = target.pop('clueToken', None)
        wins = target.pop('wins', None)
        reviewed_choices = target.pop('choices', {})
        mode = target.pop('mode', 'daily' if target['kind'] == 'sae' else 'practice')
        if args.daily_only and mode == 'practice':
            identity = f"gemma4-l21-{target['kind']}-{target['index']}-v2"
            if identity not in previous.get('practice', []) or not (args.output / f'{identity}.json').exists():
                raise ValueError(f'{identity}: --daily-only requires an existing practice pack')
            ids.append(identity)
            continue
        if mode == 'daily' and (not clue or clue_token is None or not wins):
            raise ValueError(f"{target['index']}: daily features need a reviewed clue, its strongest token, and winning examples")
        if mode == 'daily' and not all(str(band) in reviewed_choices for band in (90, 95, 99)):
            raise ValueError(f"{target['index']}: daily features need reviewed choices at 90, 95, and 99")
        playable = daily_showable if mode == 'daily' else showable
        if target['kind'] == 'sae':
            column = target['index']
        elif target['kind'] == 'neuron':
            column = manifest['features'] + manifest['neurons'].index(target['index'])
        else:
            column = manifest['features'] + len(manifest['neurons']) + manifest['mlp'].index(target['index'])
        values = matrix[:, column].toarray().ravel()
        reference = np.sort(values[values > 0])
        if len(reference) < 10000:
            raise ValueError(f"{target['index']}: fewer than 10,000 positive passages")
        scores = np.searchsorted(reference, values, side='left') * 100 / len(reference)
        scores[values == 0] = 0
        starter_index = int(np.argmin(np.where((values > 0) & (scores <= 50) & playable, 50 - scores, np.inf)))
        if clue:
            starter_index = row_ids[clue]
        minimum, maximum = (45, 55) if mode == 'daily' else (49.9, 50)
        if not playable[starter_index] or not minimum <= scores[starter_index] <= maximum:
            raise ValueError(f"{target['index']}: clue must be between the {minimum}th and {maximum}th percentiles")
        starter = passage(rows[starter_index], column, docs, args.cache, manifest, 50)
        if mode == 'daily':
            maximum = max(token['activation'] for token in starter['tokens'])
            encoded = starter['text'].encode('utf-16-le')
            peaks = {encoded[2 * token['start']:2 * token['end']].decode('utf-16-le').strip()
                     for token in starter['tokens'] if token['activation'] == maximum}
            if clue_token.strip() not in peaks:
                raise ValueError(f"{target['index']}: the reviewed clue token is not its strongest activation")
        rng = np.random.default_rng(target['index'])
        chosen = []
        counts = {}
        bands = {0: (0, 0), 50: (45, 55), 90: (88, 92), 95: (94, 96), 99: (98.5, 99.8), 99.9: (99.9, 101)}
        for band, (low, high) in bands.items():
            eligible = np.flatnonzero(values == 0) if band == 0 else np.flatnonzero((scores >= low) & (scores < high) & (values > 0))
            eligible = eligible[(eligible != starter_index) & playable[eligible]]
            review = wins if band == 99.9 else reviewed_choices.get(str(band))
            if review is not None:
                reviewed = np.array([row_ids[identity] for identity in review])
                if len(set(review)) != len(review) or not np.isin(reviewed, eligible).all():
                    raise ValueError(f"{target['index']}: reviewed band {band} needs distinct, playable passages within its measured score range")
                eligible = reviewed
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
            required = 4 if band == 99.9 else 8 if review is not None and band >= 90 else 12
            if len(unique) < required:
                raise ValueError(f"{target['index']}: band {band} has only {len(unique)} distinct documents")
            counts[str(band)] = len(unique)
            chosen.extend(passage(rows[index], column, docs, args.cache, manifest, band) for index in unique)
        version = 5 if mode == 'daily' else 2
        identity = f"gemma4-l21-{target['kind']}-{target['index']}-v{version}"
        pack = dict(id=identity, **target, reference=reference.tolist(),
                    displayScale=float(reference[min(len(reference) - 1, int(np.ceil(.999 * len(reference))))]),
                    starter=starter, passages=chosen)
        if target['kind'] == 'sae':
            with safe_open(sae_path, framework='np') as file:
                pack['encoder'] = dict(weight=file.get_slice('W_enc')[:, column:column + 1].reshape(-1).tolist(),
                                       bias=float(file.get_tensor('b_enc')[column]),
                                       threshold=float(file.get_tensor('threshold')[column]))
        path = args.output / f'{identity}.json'
        if reviewed_choices:
            pack['choiceIds'] = [p['id'] for p in chosen]
            if path.exists():
                old = json.loads(path.read_text())
                # A curation correction changes the available choices, never
                # the concept, calibration, clue, or any saved passage's scores.
                metadata = lambda value: {k: v for k, v in value.items() if k not in ('passages', 'choiceIds')}
                if metadata(old) != metadata(pack):
                    raise ValueError(f'{identity}: a choice refresh cannot change published measurements')
                archived = {p['id']: p for p in old['passages']}
                for item in chosen:
                    if item['id'] in archived and item != archived[item['id']]:
                        raise ValueError(f"{identity}: published passage {item['id']} changed")
                    archived[item['id']] = item
                pack['passages'] = list(archived.values())
        content = json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + '\n'
        if identity in frozen_ids and path.read_text() != content:
            if not (args.refresh_choices and reviewed_choices):
                raise ValueError(f'{identity}: already published; use a new pack version for measurements or --refresh-choices for reviewed suggestions.')
        path.write_text(content)
        if mode == 'practice':
            ids.append(identity)
        else:
            if target['kind'] != 'sae':
                raise ValueError('Daily targets must be curated SAE features.')
            daily_ids.append(identity)
        reports.append(dict(id=identity, positive_passages=len(reference), inactive_passages=int(np.count_nonzero(values == 0)),
                            starter_percentile=float(scores[starter_index]), bands=counts,
                            sha256=hashlib.sha256(content.encode()).hexdigest()))
    if not daily_ids:
        raise ValueError('At least one curated SAE target is required for daily puzzles.')
    first_day = date(2026, 10, 16)
    schedule = {str(first_day + timedelta(days=i)): daily_ids[i % len(daily_ids)] for i in range(90)}
    # Preserve already published daily assignments as the catalog expands.
    schedule.update(published)
    if not ids or set(ids) & set(schedule.values()):
        raise ValueError('Practice must have its own separate pool.')
    catalog = dict(version='gemma4-measured-v2', firstDay=str(first_day), daily=schedule, practice=ids)
    browser_url = previous.get('browserModel', {}).get('manifest', '/model/manifest-v2-fp4.json')
    browser_path = Path('public') / browser_url.lstrip('/')
    if browser_path.exists():
        browser = json.loads(browser_path.read_text())
        catalog['browserModel'] = dict(manifest=browser_url, bytes=browser['bytes'],
                                       approximate=browser['version'].endswith('-fp4'))
    catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
    provenance = dict(extraction=manifest, passages=len(rows), documents_by_source=dict(Counter(doc['source']['kind'] for doc in docs)),
                      sources={doc['source']['kind']: {key: doc['source'][key] for key in ['dataset', 'revision', 'license']}
                               for doc in docs},
                      scoring='strict lower rank among positive passage maxima in this fixed corpus',
                      reference_population='all non-overlapping displayed passages in the selected corpus',
                      targets=reports)
    # Keep original measurements and hashes for retained packs.
    # Flatten archives so repeated builds do not nest or duplicate old reports.
    archived_ids = (set(schedule.values()) | set(ids)) - {report['id'] for report in reports}
    archives = []
    if previous_provenance:
        for source in [previous_provenance, *previous_provenance.get('archives', [])]:
            retained = [report for report in source['targets'] if report['id'] in archived_ids]
            if retained:
                archives.append({**{k: v for k, v in source.items() if k not in ['targets', 'archives']},
                                 'targets': retained})
                archived_ids.difference_update(report['id'] for report in retained)
    if archived_ids:
        raise ValueError(f'Missing provenance for archived puzzles: {sorted(archived_ids)}')
    if archives:
        provenance['archives'] = archives
    provenance_path.write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    main()

"""Download a pinned, mixed corpus. All source documents are kept intact."""

import argparse
import gzip
import hashlib
import json
from collections import Counter
from pathlib import Path

import pyarrow.parquet as parquet
from datasets import load_dataset
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer


SOURCES = {
    "chat": ("OpenAssistant/oasst1", "fdf72ae0827c1cda404aff25b6603abec9e3399b", "Apache-2.0"),
    "prose": ("roneneldan/TinyStories", "f54c09fd23315a6f9c86f9dc80f725de7d8f9c64", "CDLA-Sharing-1.0"),
    "code": ("google-research-datasets/mbpp", "4bb6404fdc6cacfda99d4ac4205087b89d32030c", "CC-BY-4.0"),
    "reference": ("wikimedia/wikipedia", "b04c8d1ceb2f5cd4588862100d08de323dccfbaa", "CC-BY-SA-3.0"),
}


def documents(kind):
    repo, revision, license_name = SOURCES[kind]
    base = f"https://huggingface.co/datasets/{repo}/tree/{revision}"
    if kind == "chat":
        path = hf_hub_download(repo, "2023-04-12_oasst_ready.messages.jsonl.gz", repo_type="dataset", revision=revision)
        with gzip.open(path, "rt") as file:
            messages = {row["message_id"]: row for row in map(json.loads, file)}
        # One complete conversation path per root; no chat template is inserted.
        roots = set()
        for row in messages.values():
            if row["lang"] != "en" or row["role"] != "assistant" or row.get("deleted"):
                continue
            thread = [row]
            while thread[-1].get("parent_id") in messages:
                thread.append(messages[thread[-1]["parent_id"]])
            root = thread[-1]["message_id"]
            if root in roots or thread[-1].get("parent_id") is not None:
                continue
            if any(item["lang"] != "en" or item.get("deleted") for item in thread):
                continue
            roots.add(root)
            yield row["message_id"], "\n\n".join(item["text"] for item in reversed(thread)), "OpenAssistant", base
    elif kind == "code":
        data = load_dataset(repo, "full", revision=revision)
        for split, rows in data.items():
            for row in rows:
                text = row["text"] + "\n\n" + row["code"] + "\n\n" + "\n".join(row["test_list"])
                yield str(row["task_id"]), text, "Mostly Basic Python Problems", base
    else:
        filename = ("20231101.en/train-00000-of-00041.parquet" if kind == "reference"
                    else "data/train-00000-of-00004-2d5a1467fff1081b.parquet")
        path = hf_hub_download(repo, filename, repo_type="dataset", revision=revision)
        # Bounded local Parquet reads also close cleanly on CPython 3.13.
        index = 0
        for batch in parquet.ParquetFile(path).iter_batches(batch_size=128, use_threads=False):
            for row in batch.to_pylist():
                if kind == "reference":
                    yield row["id"], row["text"], row["title"], row["url"]
                else:
                    yield str(index), row["text"], "TinyStories", base
                index += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/corpus.jsonl"))
    parser.add_argument("--per-source", type=int, default=4000)
    parser.add_argument("--max-tokens", type=int, default=1024)
    args = parser.parse_args()
    tokenizer = AutoTokenizer.from_pretrained("google/gemma-4-E4B", revision="411aa17b749aa952df1359d2dcea73917a544d9a")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    counts, skipped, seen = Counter(), Counter(), set()
    with args.output.open("w") as file:
        for kind, (repo, revision, license_name) in SOURCES.items():
            for identity, text, title, url in documents(kind):
                text = text.strip()
                digest = hashlib.sha256(text.encode()).hexdigest()
                if not text or digest in seen:
                    continue
                # Skip whole documents that do not fit. Never truncate their context.
                length = len(tokenizer.encode(text, add_special_tokens=True))
                if not 32 <= length <= args.max_tokens:
                    skipped[kind] += 1
                    continue
                seen.add(digest)
                row = {"id": f"{kind}:{identity}", "text": text, "sha256": digest,
                       "source": {"kind": kind, "title": title, "url": url,
                                  "dataset": repo, "revision": revision, "license": license_name}}
                file.write(json.dumps(row, ensure_ascii=False) + "\n")
                counts[kind] += 1
                if counts[kind] >= args.per_source:
                    break
            file.flush()
            print(json.dumps({"source": kind, "documents": counts[kind], "skipped_length": skipped[kind]}), flush=True)
    manifest = {"sources": SOURCES, "documents": counts, "skipped_length": skipped,
                "max_context_tokens": args.max_tokens, "context_policy": "complete-source-document",
                "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}
    args.output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()

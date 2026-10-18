"""Split existing browser graphs at execution checkpoints, preserving every node.

Run with: uv run --with onnx python scripts/browser_steps.py
No model weights or activation scores are changed or regenerated.
"""

import argparse
import hashlib
import json
from pathlib import Path

import onnx
from onnx import helper


# Each boundary starts the following step. Use original node names so the same
# cuts preserve the CPU graph's explicit FP16 rounding casts as well.
BOUNDARIES = [
    ('Input norm', '/layer/self_attn/Constant'),
    ('Q projection', '/layer/self_attn/q_norm/Cast'),
    ('Q norm & position', '/layer/self_attn/k_proj/Transpose'),
    ('K projection', '/layer/self_attn/v_proj/Transpose'),
    ('V projection', '/layer/self_attn/k_norm/Cast'),
    ('K/V norms & position', '/layer/self_attn/Cast_4'),
    ('Attention', '/layer/self_attn/o_proj/Transpose'),
    ('O projection', '/layer/post_attention_layernorm/Cast'),
    ('Attention & MLP norms', '/layer/mlp/gate_proj/Transpose'),
    ('MLP gate projection', '/layer/mlp/up_proj/Transpose'),
    ('MLP up projection', '/layer/mlp/down_proj/Transpose'),
    ('MLP down projection', '/layer/post_feedforward_layernorm/Cast'),
    ('MLP norm & residual', '/layer/per_layer_input_gate/Transpose'),
    ('Per-layer gate & projection', '/layer/post_per_layer_input_norm/Cast'),
    ('Output norm & residual', None),
]


def gpu_outputs(graph):
    # Shape tensors stay on the CPU; floating-point activations stay on the GPU.
    return [v.name for v in graph.output
            if v.type.tensor_type.elem_type in (
                onnx.TensorProto.FLOAT16, onnx.TensorProto.FLOAT,
            )]


def split(asset, root):
    path = root / Path(asset['url']).name
    model = onnx.shape_inference.infer_shapes(onnx.load(path))
    graph = model.graph
    nodes = list(graph.node)
    info = {v.name: v for v in [*graph.input, *graph.value_info, *graph.output]}
    outputs = {v.name for v in graph.output}
    indices = {node.name: i for i, node in enumerate(nodes) if node.name}
    steps, start = [], 0
    for label, boundary in BOUNDARIES:
        end = indices[boundary] if boundary else len(nodes)
        assert end > start, (label, start, end)
        selected = nodes[start:end]
        produced = dict.fromkeys(v for node in selected for v in node.output)
        needed = {v for node in nodes[end:] for v in node.input} | outputs
        inputs = dict.fromkeys(v for node in selected for v in node.input if v and v not in produced)
        results = [v for v in produced if v in needed]
        part = onnx.ModelProto()
        part.CopyFrom(model)
        part.graph.CopyFrom(helper.make_graph(
            selected, label, [info[v] for v in inputs], [info[v] for v in results],
            value_info=[info[v] for v in produced if v not in results],
        ))
        onnx.checker.check_model(part)
        data = part.SerializeToString()
        digest = hashlib.sha256(data).hexdigest()
        filename = f'{path.stem}-step-{len(steps):02}-{digest[:12]}.onnx'
        (root / filename).write_bytes(data)
        steps.append(dict(label=label, url=f'/model/{filename}', sha256=digest,
                          gpuOutputs=gpu_outputs(part.graph)))
        start = end
    assert start == len(nodes)
    return steps


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path('public/model/manifest-v3-fp4.json'))
    parser.add_argument('--output', type=Path, default=Path('public/model/manifest-v4-fp4.json'))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    for kind in ('graphs', 'cpuGraphs'):
        for name, asset in manifest[kind].items():
            if name != 'embedding':
                asset['steps'] = split(asset, args.manifest.parent)
            else:
                path = args.manifest.parent / Path(asset['url']).name
                asset['gpuOutputs'] = gpu_outputs(onnx.load(path).graph)
    manifest['version'] = str(manifest['version']) + '-steps'
    args.output.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Wrote {args.output}; weights and full-quality scores unchanged.')

"""Make CPU-compatible graphs without changing downloaded weights or FP16 rounding.

WASM lacks FP16 arithmetic kernels. Compute those operations in FP32 and retain
the original FP16 rounding boundaries using Cast (supported by WASM).
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto as T, helper, numpy_helper


def cpu_graphs(manifest, output):
    result = {}
    for name, asset in manifest['graphs'].items():
        graph = onnx.shape_inference.infer_shapes(onnx.load(output / Path(asset['url']).name))
        values = [*graph.graph.input, *graph.graph.value_info, *graph.graph.output]
        half = {item.name for item in values if item.type.tensor_type.elem_type == T.FLOAT16}
        for item in values:
            if item.name in half:
                item.type.tensor_type.elem_type = T.FLOAT
        nodes = []
        for node in graph.graph.node:
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.TENSOR and attribute.t.data_type == T.FLOAT16:
                    attribute.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(attribute.t).astype(np.float32)))
            nodes.append(node)
            # Shape/copy operations preserve already-rounded values exactly.
            rounding = node.op_type in {'Cast', 'Add', 'Sub', 'Mul', 'Div', 'Pow', 'ReduceMean', 'MatMul', 'Softmax', 'Tanh', 'Neg'}
            for index, value in enumerate(node.output):
                if value not in half or not rounding:
                    continue
                computed, rounded = value + '_cpu_float', value + '_cpu_half'
                if node.op_type == 'Cast':
                    node.output[index] = rounded
                else:
                    node.output[index] = computed
                    nodes.append(helper.make_node('Cast', [computed], [rounded], to=T.FLOAT16))
                nodes.append(helper.make_node('Cast', [rounded], [value], to=T.FLOAT))
        del graph.graph.node[:]
        graph.graph.node.extend(nodes)
        onnx.checker.check_model(graph)
        path = output / f'{name}-cpu-v1.onnx'
        onnx.save(graph, path)
        result[name] = dict(url=f'/model/{path.name}', sha256=hashlib.sha256(path.read_bytes()).hexdigest(), weights=asset['weights'])
    manifest['cpuGraphs'] = result
    runtime = Path(__file__).resolve().parents[1] / 'node_modules/onnxruntime-web'
    assert json.loads((runtime / 'package.json').read_text())['version'] == '1.30.0'
    manifest['cpuRuntime'] = {}
    (output / 'weights').mkdir(exist_ok=True)
    for kind in ['mjs', 'wasm']:
        data = (runtime / f'dist/ort-wasm-simd-threaded.{kind}').read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        path = output / 'weights' / f'{digest}.{kind}'
        path.write_bytes(data)
        manifest['cpuRuntime'][kind] = dict(url=f'/model/weights/{path.name}', sha256=digest, bytes=len(data))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=Path('public/model/manifest-v3-fp4.json'))
    args = parser.parse_args()
    manifest = cpu_graphs(json.loads(args.manifest.read_text()), args.manifest.parent)
    args.manifest.write_text(json.dumps(manifest, indent=2) + '\n')

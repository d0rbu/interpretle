"""Weight-only experiments: blocks of 32, FP16 scales, FP16 restored weights.

FP4 uses E2M1 levels and nearest rounding (ties toward zero). Each stored block
is a little-endian FP16 scale followed by 16 bytes, low nibble first. Biases,
normalization vectors and the selected SAE encoder keep their native precision.
"""

import torch


def blocks(weights, precision):
    values = weights.float().reshape(-1, 32)
    maximum = 448 if precision == 'fp8' else 6
    scale = (values.abs().amax(dim=1, keepdim=True) / maximum).clamp_min(2 ** -24).half()
    return (values / scale.float()).clamp(-maximum, maximum), scale


def fp4_codes(values):
    levels = torch.tensor([0, .5, 1, 1.5, 2, 3, 4, 6], device=values.device)
    magnitude = torch.bucketize(values.abs().contiguous(), (levels[:-1] + levels[1:]) / 2)
    return (magnitude | ((values < 0).long() << 3)).byte(), levels


def roundtrip(weights, precision):
    values, scale = blocks(weights, precision)
    if precision == 'fp8':
        restored = values.to(torch.float8_e4m3fn).float()
    else:
        codes, levels = fp4_codes(values)
        restored = levels[(codes & 7).long()] * torch.where(codes & 8 != 0, -1., 1.)
    return (restored * scale.float()).reshape(weights.shape).half()


def pack_fp4(weights):
    values, scale = blocks(weights, 'fp4')
    codes, _ = fp4_codes(values)
    packed = codes[:, ::2] | (codes[:, 1::2] << 4)
    return torch.cat((scale.view(torch.uint8), packed), dim=1).cpu().numpy().tobytes()


def quantize_model(model, checkpoint, precision):
    from safetensors import safe_open
    count = 0
    with safe_open(checkpoint, framework='pt', device='cpu') as file, torch.inference_mode():
        for name, parameter in model.named_parameters():
            if parameter.ndim < 2:
                continue
            original = file.get_tensor('model.language_model.' + name).reshape(-1)
            destination = parameter.view(-1)
            for start in range(0, parameter.numel(), 4 * 1024 * 1024):
                values = original[start:start + 4 * 1024 * 1024].to(device=parameter.device, dtype=torch.float16)
                destination[start:start + len(values)].copy_(roundtrip(values, precision))
            count += parameter.numel()
    return count

/** Positive-passage empirical reference, constructed once for a fixed feature. */
export function calibration(activations: number[]) {
  if (
    !activations.length ||
    activations.some((x) => !Number.isFinite(x) || x < 0)
  ) {
    throw new Error('Calibration requires finite, nonnegative passage maxima.')
  }
  const positive = activations.filter((x) => x > 0).sort((a, b) => a - b)
  if (!positive.length)
    throw new Error('The feature never activates in this reference.')
  return {
    positiveCount: positive.length,
    inactiveCount: activations.length - positive.length,
    /** Strict lower rank: ties do not artificially turn a common value into a win. */
    percentile(activation: number): number {
      if (!Number.isFinite(activation) || activation < 0)
        throw new Error('Invalid activation.')
      if (activation === 0) return 0
      let left = 0
      let right = positive.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (positive[mid] < activation) left = mid + 1
        else right = mid
      }
      return (100 * left) / positive.length
    },
  }
}

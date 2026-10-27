// V2.5.5.3 P0 D3 probe (PRD §8.3): weighted binary logistic regression with a fixed L2 penalty, solved by a
// deterministic Newton iteration (no random start), evaluated out-of-fold by leaving one local date out.
import { fail } from '../dataset/lib/common.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-300) fail('P0_LOGISTIC_SINGULAR');
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

// X: rows of standardized features (no intercept column); y in {0,1}; w > 0. The intercept is not penalized.
export function fitLogistic(X, y, w, { lambda, max_iterations, tolerance }) {
  const p = (X[0]?.length ?? 0) + 1, beta = Array(p).fill(0);
  for (let iteration = 1; iteration <= max_iterations; iteration++) {
    const g = Array(p).fill(0), H = Array.from({ length: p }, () => Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = [1, ...X[i]], mu = sigmoid(x.reduce((s, v, j) => s + v * beta[j], 0)), r = w[i] * (mu - y[i]), v = w[i] * mu * (1 - mu);
      for (let j = 0; j < p; j++) { g[j] += r * x[j]; for (let k = 0; k < p; k++) H[j][k] += v * x[j] * x[k]; }
    }
    for (let j = 1; j < p; j++) { g[j] += lambda * beta[j]; H[j][j] += lambda; }
    const step = solve(H, g);
    for (let j = 0; j < p; j++) beta[j] -= step[j];
    if (Math.max(...step.map(Math.abs)) < tolerance) return { beta, converged: true, iterations: iteration };
  }
  return { beta, converged: false, iterations: max_iterations };
}

// Leave-one-date-out predictions. Training-fold means impute missing values; training-fold mean/SD standardize;
// a zero-variance training column is set to 0 for that fold.
export function looDatePredictions(rows, keys, policy) {
  const dates = [...new Set(rows.map(r => r.event_date_local))].sort(), predictions = Array(rows.length).fill(null);
  let converged = 0;
  for (const date of dates) {
    const train = rows.filter(r => r.event_date_local !== date), test = rows.map((r, i) => [r, i]).filter(([r]) => r.event_date_local === date);
    const stats = keys.map(k => {
      const v = train.map(r => r[k]).filter(finite), mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
      const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
      return { mean, sd };
    });
    const encode = r => keys.map((k, j) => { const { mean, sd } = stats[j], v = finite(r[k]) ? r[k] : mean; return sd > 0 ? (v - mean) / sd : 0; });
    const fit = fitLogistic(train.map(encode), train.map(r => r.gt_ordinal >= 2 ? 1 : 0), train.map(r => r.gt_confidence), policy);
    if (fit.converged) converged++;
    for (const [r, i] of test) predictions[i] = sigmoid([1, ...encode(r)].reduce((s, v, j) => s + v * fit.beta[j], 0));
  }
  return { predictions, folds: dates.length, converged_folds: converged };
}

/** Format milliseconds as a compact string such as "1h30m" or "45s". */
export function formatDuration(ms) {
  if (!Number.isInteger(ms) || ms < 0) throw new TypeError("ms must be a non-negative integer");
  const units = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000], ["ms", 1]];
  let rest = ms;
  let out = "";
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { out += `${n}${name}`; rest -= n * size; }
  }
  return out || "0ms";
}

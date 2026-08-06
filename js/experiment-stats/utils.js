export function round(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

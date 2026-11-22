const radians = degrees => degrees * Math.PI / 180;
const degrees = radians => radians * 180 / Math.PI;
const earthRadius = 6371000;

export function distanceMeters(a, b) {
  const latitude = radians(b[1] - a[1]);
  const longitude = radians(b[0] - a[0]);
  const fraction = Math.sin(latitude / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(longitude / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(fraction)));
}

export function positionAtDistance([lon, lat], bearing, distance) {
  const angle = distance / earthRadius;
  const latitude = radians(lat);
  const direction = radians(bearing);
  const nextLat = Math.asin(Math.sin(latitude) * Math.cos(angle) +
    Math.cos(latitude) * Math.sin(angle) * Math.cos(direction));
  const offset = Math.atan2(Math.sin(direction) * Math.sin(angle) * Math.cos(latitude),
    Math.cos(angle) - Math.sin(latitude) * Math.sin(nextLat));
  return [((lon + degrees(offset) + 540) % 360) - 180, degrees(nextLat)];
}

export function validPosition(coords) {
  return Array.isArray(coords) && coords.length === 2 && coords.every(Number.isFinite) &&
    Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90;
}

export function samplePositions(geometry, interval = 100) {
  const samples = [geometry[0]];
  let untilNext = interval;
  for (let index = 1; index < geometry.length; index++) {
    const from = geometry[index - 1];
    const to = geometry[index];
    const length = distanceMeters(from, to);
    for (; untilNext <= length; untilNext += interval) {
      const ratio = untilNext / length;
      samples.push([from[0] + ratio * (to[0] - from[0]), from[1] + ratio * (to[1] - from[1])]);
    }
    untilNext -= length;
  }
  if (distanceMeters(samples.at(-1), geometry.at(-1)) > 1) samples.push(geometry.at(-1));
  return samples;
}

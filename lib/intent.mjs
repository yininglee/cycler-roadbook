export function normalizeIntent(value = {}) {
  value ??= {};
  const text = field => typeof value[field] === 'string' ? value[field].trim().slice(0, 100) : '';
  const number = field => typeof value[field] === 'number' && value[field] >= 0 && Number.isFinite(value[field]) ? value[field] : null;
  return {
    start: text('start'), end: text('end'),
    destination: ['open', 'fixed'].includes(value.destination) ? value.destination : null,
    via: Array.isArray(value.via) ?
      value.via.filter(item => typeof item === 'string').map(item => item.trim().slice(0, 100)).filter(Boolean).slice(0, 12) : [],
    loop: typeof value.loop === 'boolean' ? value.loop : null,
    targetKm: number('targetKm'), minDistanceKm: number('minDistanceKm'), maxDistanceKm: number('maxDistanceKm'),
    maxClimbM: number('maxClimbM'), lowClimb: value.lowClimb === true,
    supply: text('supply'), requireSupply: value.requireSupply === true,
  };
}

export function readIntent(prompt) {
  const value = (pattern) => {
    const match = prompt.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const range = prompt.match(/(\d+(?:\.\d+)?)\s*(?:到|至|[-~～])\s*(\d+(?:\.\d+)?)\s*(?:公里|km)/i);
  const maxDistanceKm = range ? Number(range[2]) : value(/(?:最多|不超过|控制在|少于)\s*(\d+(?:\.\d+)?)\s*(?:公里|km)/i)
    ?? value(/(\d+(?:\.\d+)?)\s*(?:公里|km)\s*(?:内|以内)/i);
  const maxClimbM = value(/爬升[^，。；,;]{0,20}?(\d+(?:\.\d+)?)\s*(?:米|m)(?=以内|内)/i)
    ?? value(/爬升[^，。；,;]{0,16}?(?:不超过|最多|上限|控制在|降到|少于)\s*(\d+(?:\.\d+)?)\s*(?:米|m)/i);
  const start = prompt.match(/从\s*([^，。；,;、]+?)\s*出发/)?.[1] ??
    prompt.match(/起点(?:是|为|改到|改成|换成|设在)\s*([^，。；,;、]+)/)?.[1] ?? '';
  const end = prompt.match(/(?:终点(?:是|为|设在|改为|改成|改到|换成)|骑到|到达)\s*([^，。；,;、]+?)(?=[，。；,;、]|$)/)?.[1] ?? '';
  const via = [...prompt.matchAll(/(?:必经|途经|经过)(?!点)\s*([^，。；,;、]+?)(?=[，。；,;、]|$)/g)]
    .flatMap(match => match[1].split(/以及|\s+和\s+/)).filter(place => !/补给|便利店/.test(place));
  const supply = /补给|便利店/.test(prompt) ? '便利店' : '';
  const flexibleEnd = /不限终点|终点(?:不限|随意|任意|由你|你定|你选|都行|都可以|交给你)|(?:随便|帮我|自动)(?:选|定)(?:个|一个)?终点|(?:没有|无|不设|不指定|没有指定)(?:固定)?终点|骑到哪(?:儿|里)?(?:都行|都可以|算哪(?:儿|里)?)|去哪(?:儿|里)?都行/.test(prompt);
  const loop = /不用回(?:到)?起点|不(?:要|用|骑)?(?:环线|折返)|单程|点到点/.test(prompt) ? false :
    /环线|回到起点|返回起点|回起点|骑一圈|绕一圈/.test(prompt) ? true : null;
  const namedEnd = flexibleEnd ? '' : end;
  return normalizeIntent({
    start, end: namedEnd, via, loop: loop ?? (namedEnd || flexibleEnd ? false : null),
    destination: flexibleEnd ? 'open' : namedEnd || /点到点/.test(prompt) ? 'fixed' : null,
    targetKm: maxDistanceKm === null && !/至少/.test(prompt) ? value(/(\d+(?:\.\d+)?)\s*(?:公里|km)/i) : null,
    minDistanceKm: range ? Number(range[1]) : value(/至少\s*(\d+(?:\.\d+)?)\s*(?:公里|km)/i),
    maxDistanceKm, maxClimbM, lowClimb: /少爬坡|少爬升|降低爬升|降低坡度|尽量平|平一点|爬升最少/.test(prompt),
    supply, requireSupply: Boolean(supply && /必须补给|需要补给|必经.*(?:补给|便利店)|途经.*便利店/.test(prompt)),
  });
}

export const demoBounds = { west: 119.95, east: 120.31, south: 30.075, north: 30.34 };

export const demoPlaces = [
  { id: 'hub', name: '西湖文化广场', address: '杭州 · 拱墅区', coords: [120.161, 30.279], kind: 'landmark' },
  { id: 'lake', name: '杨公堤', address: '杭州 · 西湖区', coords: [120.132, 30.236], kind: 'landmark' },
  { id: 'tea', name: '龙井村', address: '杭州 · 西湖区', coords: [120.103, 30.224], kind: 'landmark' },
  { id: 'creek', name: '九溪', address: '杭州 · 西湖区', coords: [120.115, 30.186], kind: 'landmark' },
  { id: 'tower', name: '六和塔', address: '杭州 · 西湖区', coords: [120.135, 30.194], kind: 'landmark' },
  { id: 'river', name: '钱塘江骑行驿站', address: '杭州 · 上城区 · 演示补给点', coords: [120.197, 30.225], kind: 'supply' },
  { id: 'shop', name: '龙井补给站', address: '杭州 · 西湖区 · 演示补给点', coords: [120.098, 30.237], kind: 'supply' },
  { id: 'wetland', name: '西溪湿地', address: '杭州 · 西湖区', coords: [120.062, 30.269], kind: 'landmark' },
  { id: 'bridge', name: '复兴大桥', address: '杭州 · 上城区', coords: [120.172, 30.218], kind: 'landmark' },
  { id: 'park', name: '白马湖公园', address: '杭州 · 滨江区', coords: [120.192, 30.171], kind: 'landmark' },
  { id: 'xiang', name: '湘湖', address: '杭州 · 萧山区', coords: [120.226, 30.148], kind: 'landmark' },
  { id: 'yunqi', name: '云栖竹径', address: '杭州 · 西湖区', coords: [120.078, 30.183], kind: 'landmark' },
  { id: 'east', name: '钱江新城', address: '杭州 · 上城区', coords: [120.223, 30.258], kind: 'landmark' },
  { id: 'canal', name: '拱宸桥', address: '杭州 · 拱墅区', coords: [120.142, 30.319], kind: 'landmark' },
];

export const demoRoads = [
  ['hub','lake',[[120.150,30.274],[120.136,30.263],[120.132,30.252]]],
  ['hub','east',[[120.181,30.283],[120.201,30.271],[120.216,30.268]]],
  ['hub','canal',[[120.158,30.296],[120.149,30.309]]],
  ['canal','wetland',[[120.114,30.311],[120.089,30.310],[120.068,30.288]]],
  ['lake','tea',[[120.124,30.230],[120.117,30.222],[120.111,30.225]]],
  ['lake','bridge',[[120.142,30.231],[120.154,30.223]]],
  ['lake','shop',[[120.123,30.246],[120.111,30.246],[120.103,30.243]]],
  ['tea','shop',[[120.101,30.230]]],
  ['tea','creek',[[120.102,30.214],[120.110,30.207],[120.109,30.197]]],
  ['tea','yunqi',[[120.085,30.222],[120.087,30.208],[120.078,30.203]]],
  ['shop','wetland',[[120.089,30.247],[120.075,30.248],[120.073,30.257]]],
  ['creek','yunqi',[[120.103,30.181],[120.091,30.178]]],
  ['creek','tower',[[120.124,30.186],[120.130,30.190]]],
  ['tower','bridge',[[120.147,30.197],[120.157,30.211],[120.165,30.215]]],
  ['bridge','river',[[120.186,30.219],[120.193,30.222]]],
  ['bridge','park',[[120.178,30.208],[120.179,30.193],[120.189,30.181]]],
  ['park','xiang',[[120.207,30.169],[120.213,30.155]]],
  ['xiang','river',[[120.224,30.182],[120.216,30.198],[120.209,30.210]]],
  ['river','east',[[120.207,30.229],[120.216,30.241],[120.222,30.250]]],
];

export const demoPresets = {
  scenic: ['hub','lake','tea','creek','tower','bridge','river'],
  ring: ['hub','canal','wetland','shop','tea','creek','tower','bridge','river','east'],
};

export const isCurrentLocation = name => /^(?:我(?:的)?)?(?:当前位置|当前定位|所在位置)$/.test(name);

export const isLocationReply = prompt =>
  /^(?:附近|我附近|我这附近|这里|这儿|我这里|我这儿|我这边|用我的位置|用定位|我?(?:已经|已|刚刚|刚)?定位(?:好了|完成了|了|完成|成功了|成功))[。！？!.?]*$/.test(prompt.trim());

export const mentionsCurrentLocation = prompt => /当前位置|当前定位|所在位置/.test(prompt);

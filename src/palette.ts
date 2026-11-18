// One small set of saturated swatches. Everything in the world draws from here,
// so swapping a value restyles the whole diorama.
export const palette = {
  skyTop: 0x38a3f5,
  skyHorizon: 0xffe6bf,
  skyBottom: 0x86d8f2,

  water: 0x12b4dc,
  sand: 0xffd873,
  grassLow: 0x9be64a,
  grassMid: 0x4fcf55,
  grassHigh: 0x1fa867,
  rock: 0xe58f52,
  rockDark: 0xb9603a,
  stone: 0xb79ee0,
  snow: 0xfff7ea,

  earth: 0xa8643c,
  bedrock: 0x6b4a6e,
  cloud: 0xffffff,

  // Foliage
  needles: 0x0f8a6a,
  needlesLight: 0x19a878,
  bark: 0x8a4b2e,
  barkDark: 0x6e3f2a,
  frond: 0x35c24a,
  frondLight: 0x74dc4a,
  cycadFrond: 0xb7e83a,
  cycadFrondDark: 0x8fd62f,
  cycadTrunk: 0xc9742f,
  fern: 0x7fe04a,
  fernDark: 0x4fc64a,
  horsetail: 0x2fb7a0,
  horsetailLight: 0x62dcb8,
  boulder: 0xa58fd6,

  sun: 0xfff1d6,
  skyLight: 0xdff2ff,
  bounceLight: 0xf7c88a,
};

// Height bands (world units above the water line) used to colour terrain faces.
export const bands = {
  sand: 0.7,
  grassLow: 7,
  grassMid: 15,
  grassHigh: 24,
  stone: 30,
  // Faces steeper than these (normal.y below the value) become cliff rock.
  cliff: 0.66,
  cliffDark: 0.5,
};

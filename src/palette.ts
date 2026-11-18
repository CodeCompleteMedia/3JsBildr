// One small set of saturated swatches. Everything in the world draws from here,
// so swapping a value restyles the whole diorama.
export const palette = {
  skyTop: 0x38a3f5,
  skyHorizon: 0xffe6bf,
  skyBottom: 0x86d8f2,

  water: 0x1fc3e0,
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

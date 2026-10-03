export interface ScreenBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlayerAnchor {
  x: number;
  y: number;
  bounds: ScreenBounds;
}

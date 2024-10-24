export interface Curtain3State {
	// 0 - decreasing
	// 1 - increasing
	// 2 - stopped
	positionState: 0 | 1 | 2;
	batteryLevel: number;
	currentPosition: number;
	targetPosition: number;
}

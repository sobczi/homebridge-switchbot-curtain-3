import {
	type CharacteristicValue,
	type PlatformAccessory,
	type Service,
} from "homebridge";

import { Advertisement, Characteristic, Peripheral } from "@stoprocent/noble";
import { BluetoothLowEnergy } from "./bluetoothLowEnergy.js";
import { Curtain3State } from "./models/Curtain3State.js";
import type { SwitchBotCurtain3Platform } from "./platform.js";

export class SwitchBotCurtain3Accessory {
	private service: Service;

	private currentState: Curtain3State;

	private lastAdLogTime: number = 0;
	private lastPositionChangeTime: number = 0;
	private movementStartTime: number = 0;
	private isFirstAdvertisement: boolean = true;

	constructor(
		private readonly platform: SwitchBotCurtain3Platform,
		private readonly accessory: PlatformAccessory,
		private readonly curtain: Peripheral,
		private readonly ble: BluetoothLowEnergy
	) {
		this.currentState = this.setInitialState();
		this.watchAds();

		// set accessory information
		this.accessory
			.getService(this.platform.Service.AccessoryInformation)!
			.setCharacteristic(this.platform.Characteristic.Manufacturer, "SwitchBot")
			.setCharacteristic(this.platform.Characteristic.Model, "Curtain 3");

		// you can create multiple services for each accessory
		this.service =
			this.accessory.getService(this.platform.Service.WindowCovering) ||
			this.accessory.addService(this.platform.Service.WindowCovering);

		// set the service name, this is what is displayed as the default name on the Home app
		// in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
		this.service.setCharacteristic(
			this.platform.Characteristic.Name,
			"SwitchBot Curtain 3"
		);

		// Current Position
		this.service
			.getCharacteristic(this.platform.Characteristic.CurrentPosition)
			.onSet(this.setCurrentPosition.bind(this))
			.onGet(this.getCurrentPosition.bind(this));

		// PositionState
		this.service
			.getCharacteristic(this.platform.Characteristic.PositionState)
			.onSet(this.setPositionState.bind(this))
			.onGet(this.getPositionState.bind(this));

		// Target Position
		this.service
			.getCharacteristic(this.platform.Characteristic.TargetPosition)
			.onSet(this.setTargetPosition.bind(this))
			.onGet(this.getTargetPosition.bind(this));
	}

	// Current Position

	getCurrentPosition(): number {
		return this.currentState.currentPosition;
	}

	setCurrentPosition(param: CharacteristicValue): void {
		const value = param as number;
		if (value !== this.currentState.currentPosition) {
			this.platform.log.debug(`Changing current position to: ${value}`);
			this.currentState.currentPosition = value;
			// Update the HomeKit characteristic to reflect the change
			this.service.updateCharacteristic(
				this.platform.Characteristic.CurrentPosition,
				value
			);
		}
	}

	// PositionState

	getPositionState(): number {
		return this.currentState.positionState;
	}

	setPositionState(value: CharacteristicValue): void {
		if (value !== this.currentState.positionState) {
			this.platform.log.info(
				`Changing position state to: ${value} (0 - decreasing, 1 - increasing, 2 - stopped)`
			);
			this.currentState.positionState = value as 0 | 1 | 2;

			// Update the HomeKit characteristic to reflect the change
			try {
				// Force HomeKit refresh with aggressive state cycling when setting to STOPPED
				if (value === this.platform.Characteristic.PositionState.STOPPED) {
					// First, briefly set to a different state to force refresh
					const oppositeState = this.currentState.positionState === 0 ? 1 : 0;
					this.service.setCharacteristic(
						this.platform.Characteristic.PositionState,
						oppositeState
					);

					// Then immediately set to STOPPED
					setTimeout(() => {
						this.service.setCharacteristic(
							this.platform.Characteristic.PositionState,
							this.platform.Characteristic.PositionState.STOPPED
						);
						this.service.updateCharacteristic(
							this.platform.Characteristic.PositionState,
							this.platform.Characteristic.PositionState.STOPPED
						);
					}, 100);
				} else {
					// For non-STOPPED states, use normal update
					this.service.setCharacteristic(
						this.platform.Characteristic.PositionState,
						value
					);
					this.service.updateCharacteristic(
						this.platform.Characteristic.PositionState,
						value
					);
				}

				// Also force update current and target position to trigger refresh
				this.service.updateCharacteristic(
					this.platform.Characteristic.CurrentPosition,
					this.getCurrentPosition()
				);
				this.service.updateCharacteristic(
					this.platform.Characteristic.TargetPosition,
					this.getTargetPosition()
				);
				this.platform.log.debug(
					`HomeKit characteristic updated successfully to: ${value}`
				);

				// Force a delayed secondary update to break HomeKit caching
				if (value === this.platform.Characteristic.PositionState.STOPPED) {
					setTimeout(() => {
						this.platform.log.debug(
							"Sending delayed STOPPED state update to break HomeKit cache"
						);
						this.service.updateCharacteristic(
							this.platform.Characteristic.PositionState,
							this.platform.Characteristic.PositionState.STOPPED
						);

						// Also trigger accessory information refresh as a last resort
						this.accessory
							.getService(this.platform.Service.AccessoryInformation)!
							.updateCharacteristic(
								this.platform.Characteristic.Manufacturer,
								"SwitchBot"
							);
					}, 500);
				}
			} catch (error) {
				this.platform.log.error(
					`Failed to update HomeKit characteristic: ${error}`
				);
			}
		} else {
			this.platform.log.debug(
				`Position state already set to: ${value}, no change needed`
			);
		}
	}

	// Target position

	getTargetPosition(): number {
		return this.currentState.targetPosition;
	}

	private setTargetPositionInternal(value: number): void {
		if (value !== this.currentState.targetPosition) {
			this.currentState.targetPosition = value;
			// Update the HomeKit characteristic to reflect the change
			this.service.updateCharacteristic(
				this.platform.Characteristic.TargetPosition,
				value
			);
		}
	}

	async setTargetPosition(param: CharacteristicValue): Promise<void> {
		const value = param as number;
		this.setTargetPositionInternal(value);

		if (this.getTargetPosition() === this.getCurrentPosition()) {
			this.platform.log.info(
				`Target position ${value}% matches current position, no movement needed`
			);
			this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
			return;
		}

		this.platform.log.info(
			`Setting target position to: ${value}% (current: ${this.getCurrentPosition()}%)`
		);
		const willIncrease = value > this.getCurrentPosition();
		const newPosition = willIncrease
			? this.platform.Characteristic.PositionState.INCREASING
			: this.platform.Characteristic.PositionState.DECREASING;

		this.movementStartTime = Date.now();
		this.lastPositionChangeTime = this.movementStartTime;

		this.platform.log.info(
			`Curtain will ${
				willIncrease ? "open (INCREASING)" : "close (DECREASING)"
			}`
		);
		this.setPositionState(newPosition);

		try {
			await this.changePosition(value);
			this.platform.log.info(
				`Position change command sent successfully to ${value}%`
			);

			// Don't immediately update current position - let advertisements handle it
			// Don't set state to stopped yet - let advertisement parsing detect when movement stops
		} catch (error) {
			this.platform.log.error(`Failed to change position: ${error}`);
			this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
			throw error;
		}
	}

	private async changePosition(position: number): Promise<void> {
		position = Math.max(0, Math.min(100, position));
		position = 100 - position;

		const bytes = [0x57, 0x0f, 0x45, 0x01, 0x05, 0xff, position];
		const buffer = Buffer.from(bytes);

		this.platform.log.debug(
			`[changePosition]: Current status: ${this.curtain.state}`
		);
		if (["connecting", "disconnecting"].includes(this.curtain.state)) {
			return;
		}

		if (!["disconnected", "connected"].includes(this.curtain.state)) {
			throw new Error("Invalid curtain status.");
		}

		if (this.curtain.state === "disconnected") {
			await this.curtain.connectAsync();
		}

		let writeChar: Characteristic | undefined;
		let notifyChar: Characteristic | undefined;
		while (!writeChar) {
			const services = await this.curtain.discoverServicesAsync();
			this.platform.log.debug(`services: ${services.length}`);

			for (const service of services) {
				const characteristics = await service.discoverCharacteristicsAsync();
				this.platform.log.debug(`characteristics: ${characteristics.length}`);

				if (!writeChar) {
					writeChar = characteristics.find((c) =>
						c.properties.includes("write")
					);
				}

				if (!notifyChar) {
					notifyChar = characteristics.find((c) =>
						c.properties.includes("notify")
					);
				}

				if (writeChar) {
					break;
				}
			}

			if (!writeChar) {
				this.platform.log.error("write char not found. reruning");
			}

			if (!notifyChar) {
				this.platform.log.error("notify char not found. reruning");
			}
		}

		if (!writeChar) {
			throw Error("Couldn't find write charateristics");
		}

		this.platform.log.info(
			`Sending position change command to device (target: ${position})`
		);

		// Enable notifications to receive feedback
		notifyChar?.notify(true);

		// Set up data handler before sending command
		notifyChar?.on("data", (data) => {
			this.platform.log.info(
				`Received response from device: ${data.toString("hex")}`
			);
		});

		// Send the position change command
		writeChar.writeAsync(buffer, true);
		this.platform.log.info(
			"Position change command sent to device successfully"
		);

		// Wait for the device to process the command before disconnecting
		this.platform.log.debug(
			"Waiting 10 seconds for device to process command..."
		);
		await new Promise((resolve) => setTimeout(resolve, 10000));

		// Disconnect and resume watching advertisements
		if (this.curtain.state === "connected") {
			await this.curtain.disconnectAsync();
			this.platform.log.debug(
				"Disconnected from device, resuming advertisement watching"
			);
			this.watchAds();
		}
	}

	private watchAds(): void {
		this.platform.log.debug("Starting to watch advertisements");
		this.ble.onAd = (ad: Advertisement) => this.parseAd(ad);
		this.ble.watchAds();

		// If we're resuming ads after a movement command and we're not in STOPPED state,
		// reset the movement start time to now (since we're starting to monitor actual movement)
		if (
			this.getPositionState() !==
			this.platform.Characteristic.PositionState.STOPPED
		) {
			// Reset movement start time to when we start watching ads (actual movement monitoring)
			this.movementStartTime = Date.now();
			this.platform.log.debug(
				"Reset movement start time - now monitoring actual curtain movement"
			);

			// give it a moment then check if we should force stop
			// Immediate check - if it's been more than 12 seconds since movement start, force stop immediately
			const timeSinceStart = Date.now() - this.movementStartTime;
			if (timeSinceStart > 12000) {
				this.platform.log.info(
					"Force stopping immediately - curtain likely finished moving during delay period"
				);
				this.setPositionState(
					this.platform.Characteristic.PositionState.STOPPED
				);
			} else {
				// Otherwise, check after a short delay
				setTimeout(() => {
					if (
						this.getPositionState() !==
						this.platform.Characteristic.PositionState.STOPPED
					) {
						this.platform.log.info(
							"Force stopping after timeout - no movement detected"
						);
						this.setPositionState(
							this.platform.Characteristic.PositionState.STOPPED
						);
					}
				}, 1000); // Reduced from 2000 to 1000ms for faster response
			}
		}
	}

	private parseAd(ad: Advertisement): void {
		const serviceData = ad.serviceData[0]?.data;
		const { data: bufferData } = JSON.parse(JSON.stringify(serviceData)) as any;

		const position: number =
			bufferData[3] > 100 ? bufferData[3] - 128 : bufferData[3];
		const revertedPosition = 100 - position;

		const previousPosition = this.getCurrentPosition();
		const currentTime = Date.now();
		const timeSinceLastLog = currentTime - this.lastAdLogTime;
		const shouldLog = timeSinceLastLog >= 2000; // 2 seconds debounce

		// Handle first advertisement specially - just sync position without triggering movement logic
		if (this.isFirstAdvertisement) {
			this.isFirstAdvertisement = false;
			this.platform.log.info(
				`Initial position from advertisement: ${revertedPosition}%`
			);
			this.setCurrentPosition(revertedPosition);
			this.setTargetPositionInternal(revertedPosition); // Set target to match current
			this.lastPositionChangeTime = currentTime;
			this.lastAdLogTime = currentTime;
			return;
		}

		if (revertedPosition !== previousPosition) {
			// Position has changed - update timestamp and log
			this.lastPositionChangeTime = currentTime;

			// Check for large position jumps (likely movement during 10s delay period)
			const positionDifference = Math.abs(revertedPosition - previousPosition);
			const timeSinceMovementStart = currentTime - this.movementStartTime;

			if (positionDifference > 10) {
				// Large jump - curtain likely moved during delay period
				this.platform.log.info(
					`Large position change detected: ${previousPosition}% → ${revertedPosition}% (likely moved during delay period)`
				);
				// Set movement start time further back to account for the hidden movement
				this.movementStartTime = currentTime - 5000; // Assume 5s of movement already happened
			}

			const minimumMovementTime = 3000; // Require at least 3 seconds of movement

			// Always log significant position changes, but respect debounce for unchanged positions
			if (shouldLog || Math.abs(revertedPosition - previousPosition) >= 1) {
				this.platform.log.info(
					`Position updated via advertisement: ${revertedPosition}% (was ${previousPosition}%)`
				);
				this.lastAdLogTime = currentTime;
			}

			this.setCurrentPosition(revertedPosition);

			// Check if we've reached the target position or are very close FIRST
			const targetPosition = this.getTargetPosition();
			const distanceFromTarget = Math.abs(revertedPosition - targetPosition);

			if (
				distanceFromTarget <= 2 &&
				timeSinceMovementStart > minimumMovementTime
			) {
				// We've reached the target (within 2%) AND enough time has passed, set state to stopped
				if (
					this.getPositionState() !==
					this.platform.Characteristic.PositionState.STOPPED
				) {
					this.platform.log.info(
						`Curtain reached target position ${revertedPosition}% (target: ${targetPosition}%) after ${Math.round(
							timeSinceMovementStart / 1000
						)}s, stopping`
					);
					this.setPositionState(
						this.platform.Characteristic.PositionState.STOPPED
					);
				}
			} else if (distanceFromTarget <= 2) {
				// Close to target but too soon - log but don't stop yet
				this.platform.log.debug(
					`Close to target ${revertedPosition}%→${targetPosition}% but only ${Math.round(
						timeSinceMovementStart / 1000
					)}s elapsed, continuing...`
				);
			} else {
				// Don't auto-update target during movement - only when movement stops
				// This prevents the target from being changed while curtain is moving
				this.platform.log.debug(
					`Moving towards target: current ${revertedPosition}%, target ${targetPosition}% (${distanceFromTarget}% away)`
				);
			}
		} else {
			// Position hasn't changed - check if we should consider movement stopped
			const timeSinceLastMovement = currentTime - this.lastPositionChangeTime;
			const timeSinceMovementStart = currentTime - this.movementStartTime;

			if (
				this.getPositionState() !==
					this.platform.Characteristic.PositionState.STOPPED &&
				(timeSinceLastMovement > 1500 || timeSinceMovementStart > 60000)
			) {
				// Stop if: 1.5 seconds without movement OR 60 seconds since movement started (timeout)
				const reason =
					timeSinceMovementStart > 60000
						? `movement timeout after ${Math.round(
								timeSinceMovementStart / 1000
						  )}s`
						: `no movement for ${Math.round(timeSinceLastMovement / 1000)}s`;

				this.platform.log.info(
					`Curtain movement stopped at position ${revertedPosition}% (${reason})`
				);
				this.setPositionState(
					this.platform.Characteristic.PositionState.STOPPED
				);

				// Update target to match current if we didn't reach the original target
				if (Math.abs(revertedPosition - this.getTargetPosition()) > 1) {
					this.setTargetPositionInternal(revertedPosition);
				}
			} else if (
				this.getPositionState() ===
				this.platform.Characteristic.PositionState.STOPPED
			) {
				// Only log unchanged position with debounce when already stopped
				if (shouldLog) {
					this.platform.log.debug(
						`Ad position unchanged: ${revertedPosition}% (state: ${this.getPositionState()} = STOPPED)`
					);
					this.lastAdLogTime = currentTime;
				}
			} else {
				// This shouldn't happen - log it for debugging
				this.platform.log.warn(
					`Unexpected state: position unchanged but state is ${this.getPositionState()} (not STOPPED)`
				);
			}
		}
	}

	private setInitialState(): Curtain3State {
		return {
			positionState: 2,
			batteryLevel: 100,
			currentPosition: 100,
			targetPosition: 100,
		};
	}

	// Method to force reset the position state (useful for debugging)
	forceStopState(): void {
		this.platform.log.info("Force setting position state to STOPPED");
		this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
	}
}

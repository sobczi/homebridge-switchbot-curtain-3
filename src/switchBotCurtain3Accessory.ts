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
			this.platform.log.debug(
				`Changing position state to: ${value} (0 - decreasing, 1 - increasing, 2 - stopped)`
			);
			this.currentState.positionState = value as 0 | 1 | 2;
			// Update the HomeKit characteristic to reflect the change
			this.service.updateCharacteristic(
				this.platform.Characteristic.PositionState,
				value
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

		this.platform.log.info(`Setting target position to: ${value}% (current: ${this.getCurrentPosition()}%)`);
		const willIncrease = value > this.getCurrentPosition();
		const newPosition = willIncrease
			? this.platform.Characteristic.PositionState.INCREASING
			: this.platform.Characteristic.PositionState.DECREASING;

		this.movementStartTime = Date.now();
		this.lastPositionChangeTime = this.movementStartTime;
		
		this.platform.log.info(`Curtain will ${willIncrease ? 'open (INCREASING)' : 'close (DECREASING)'}`);
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

		if (revertedPosition !== previousPosition) {
			// Position has changed - update timestamp and log
			this.lastPositionChangeTime = currentTime;

			// Always log significant position changes, but respect debounce for unchanged positions
			if (shouldLog || Math.abs(revertedPosition - previousPosition) >= 1) {
				this.platform.log.info(
					`Position updated via advertisement: ${revertedPosition}% (was ${previousPosition}%)`
				);
				this.lastAdLogTime = currentTime;
			}

			this.setCurrentPosition(revertedPosition);

			// Only update target position if it's significantly different (prevents drift)
			if (Math.abs(revertedPosition - this.getTargetPosition()) > 5) {
				this.setTargetPositionInternal(revertedPosition);
			}

			// Check if we've reached the target position or are very close
			const targetPosition = this.getTargetPosition();
			if (Math.abs(revertedPosition - targetPosition) <= 1) {
				// We've reached the target, set state to stopped
				if (
					this.getPositionState() !==
					this.platform.Characteristic.PositionState.STOPPED
				) {
					this.platform.log.info(
						`Curtain reached target position ${revertedPosition}%, stopping`
					);
					this.setPositionState(
						this.platform.Characteristic.PositionState.STOPPED
					);
				}
			}
		} else {
			// Position hasn't changed - check if we should consider movement stopped
			const timeSinceLastMovement = currentTime - this.lastPositionChangeTime;
			const timeSinceMovementStart = currentTime - this.movementStartTime;

			if (
				this.getPositionState() !==
					this.platform.Characteristic.PositionState.STOPPED &&
				(timeSinceLastMovement > 3000 || timeSinceMovementStart > 60000)
			) {
				// Stop if: 3 seconds without movement OR 60 seconds since movement started (timeout)
				const reason = timeSinceMovementStart > 60000 ? 
					`movement timeout after ${Math.round(timeSinceMovementStart / 1000)}s` :
					`no movement for ${Math.round(timeSinceLastMovement / 1000)}s`;
				
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
						`Ad position unchanged: ${revertedPosition}%`
					);
					this.lastAdLogTime = currentTime;
				}
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

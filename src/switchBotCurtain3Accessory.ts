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
		}
		this.currentState.currentPosition = value;
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
		}
		this.currentState.positionState = value as 0 | 1 | 2;
	}

	// Target position

	getTargetPosition(): number {
		return this.currentState.targetPosition;
	}

	async setTargetPosition(param: CharacteristicValue): Promise<void> {
		const value = param as number;
		this.currentState.targetPosition = value;

		if (this.getTargetPosition() === this.getCurrentPosition()) {
			this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
			return;
		}

		this.platform.log.debug(`Changing target position to: ${value}`);
		const willIncrease = value > this.getCurrentPosition();
		const newPosition = willIncrease
			? this.platform.Characteristic.PositionState.INCREASING
			: this.platform.Characteristic.PositionState.DECREASING;

		this.setPositionState(newPosition);
		await this.changePosition(value);
		const changedPosition = this.getCurrentPosition();
		if (changedPosition !== this.getTargetPosition()) {
			this.platform.log.debug(`Position change to ${changedPosition} failed.`);
		}
		this.platform.log.debug(
			`Change position success. Changing state to stopped.`
		);
		this.setPositionState(this.platform.Characteristic.PositionState.STOPPED);
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

				for (const char of characteristics) {
					this.platform.log.debug(
						`Characteristic UUID: ${char.uuid}, properties: ${char.type}`
					);
				}

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

		this.platform.log.debug(`Sending change position request to device`);
		await new Promise((resolve, reject) => {
			notifyChar?.notify(true, (error) => {
				if (error) {
					this.platform.log.error(`Failed to enable notifications: ${error}`);
					reject(error);
				} else {
					this.platform.log.debug("Notifications successfully enabled.");
					resolve("");
				}
			});
		});
		await writeChar.writeAsync(buffer, true);

		notifyChar?.on("data", (data) => {
			this.platform.log.debug(data.toString());
		});

		if (this.curtain.state === "connected") {
			await this.curtain.disconnectAsync();
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

		this.platform.log.debug(`Ad position: ${position}`);

		this.setCurrentPosition(revertedPosition);
		this.setTargetPosition(revertedPosition);
	}

	private setInitialState(): Curtain3State {
		return {
			positionState: 2,
			batteryLevel: 100,
			currentPosition: 100,
			targetPosition: 100,
		};
	}
}

import {
	type CharacteristicValue,
	type PlatformAccessory,
	type Service,
} from "homebridge";

import type { SwitchBotCurtain3Platform } from "./platform.js";
import { Curtain3State } from "./models/Curtain3State.js";
import { SwitchBotBLE, SwitchbotDevice, WoCurtain } from "switchbot-curtain-3";

export class SwitchBotCurtain3Accessory {
	private service: Service;

	private currentState: Curtain3State;

	private ble: SwitchBotBLE;

	constructor(
		private readonly platform: SwitchBotCurtain3Platform,
		private readonly accessory: PlatformAccessory,
		private readonly woCurtain: WoCurtain
	) {
		this.currentState = this.setInitialState();
		this.ble = new SwitchBotBLE();
		this.startScanning();
		this.watchScanningResults();
		this.woCurtain.connect();

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

		// Battery
		this.service
			.getCharacteristic(this.platform.Characteristic.BatteryLevel)
			.onSet(this.setBatteryLevel.bind(this))
			.onGet(this.getBatteryLevel.bind(this));
	}

	// Context

	getContext(): SwitchbotDevice {
		return this.accessory.context as SwitchbotDevice;
	}

	// Battery Level

	getBatteryLevel(): number {
		return this.currentState.batteryLevel;
	}

	setBatteryLevel(value: CharacteristicValue): void {
		this.currentState.batteryLevel = value as number;
	}

	// Current Position

	getCurrentPosition(): number {
		return this.currentState.currentPosition;
	}

	setCurrentPosition(value: CharacteristicValue): void {
		this.currentState.currentPosition = 100 - (value as number);
	}

	// PositionState

	getPositionState(): number {
		return this.currentState.positionState;
	}

	setPositionState(value: CharacteristicValue): void {
		this.currentState.positionState = value as 0 | 1 | 2;
	}

	// Target position

	getTargetPosition(): number {
		return this.currentState.targetPosition;
	}

	async setTargetPosition(value: CharacteristicValue): Promise<void> {
		const revertedValue = 100 - (value as number);
		this.currentState.targetPosition = revertedValue;

		if (this.getTargetPosition() === this.getCurrentPosition()) {
			return;
		}

		this.platform.log.info(`Target position changed to ${value}%`);

		const willIncrease = revertedValue > this.getCurrentPosition();
		this.setPositionState(
			willIncrease
				? this.platform.Characteristic.PositionState.INCREASING
				: this.platform.Characteristic.PositionState.DECREASING
		);

		await this.woCurtain.runToPos(revertedValue);
	}

	private watchScanningResults(): void {
		this.ble.onadvertisement = ({
			serviceData: { battery, inMotion, position },
		}) => {
			const p = position as number;

			// 128 w przypadku zwiekszania zakresu zaciemnienia
			const pos: number = p > 100 ? p - 128 : p;

			// Position is -1 when value is 225 || 228 => it is during movement
			this.setCurrentPosition(pos);
			this.setBatteryLevel(battery as number);

			if (!inMotion) {
				this.setTargetPosition(pos);
				this.setPositionState(
					this.platform.Characteristic.PositionState.STOPPED
				);
			}
		};
	}

	private startScanning(): void {
		this.ble.startScan({ id: this.woCurtain.deviceAddress });
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

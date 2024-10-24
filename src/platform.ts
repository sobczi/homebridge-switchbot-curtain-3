import type {
	API,
	Characteristic,
	DynamicPlatformPlugin,
	Logging,
	PlatformAccessory,
	Service,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { Curtain3Config } from "./models/Curtain3Config.js";
import { SwitchBotCurtain3Accessory } from "./switchBotCurtain3Accessory.js";
import { BluetoothLowEnergy } from "./bluetoothLowEnergy.js";
import { Peripheral } from "@stoprocent/noble";

export class SwitchBotCurtain3Platform implements DynamicPlatformPlugin {
	public readonly Service: typeof Service;
	public readonly Characteristic: typeof Characteristic;

	public readonly accessories: PlatformAccessory[] = [];

	private readonly ble: BluetoothLowEnergy;

	constructor(
		public readonly log: Logging,
		public readonly config: Curtain3Config,
		public readonly api: API
	) {
		this.Service = api.hap.Service;
		this.Characteristic = api.hap.Characteristic;
		this.ble = new BluetoothLowEnergy();
		this.ble.log = this.log;

		this.log.debug("Finished initializing platform:", this.config.name);

		// When this event is fired it means Homebridge has restored all cached accessories from disk.
		// Dynamic Platform plugins should only register new accessories after this event was fired,
		// in order to ensure they weren't added to homebridge already. This event can also be used
		// to start discovery of new accessories.
		this.api.on("didFinishLaunching", () => {
			log.debug("Executed didFinishLaunching callback");
			// run the method to discover / register your devices as accessories
			this.discoverDevices();
		});
	}

	configureAccessory(accessory: PlatformAccessory) {
		this.log.info("Loading accessory from cache:", accessory.displayName);

		this.accessories.push(accessory);
	}

	async discoverDevices() {
		const macAddress = this.config.macAddress;
		if (!macAddress) {
			return;
		}

		this.ble.watchedMacAddresses = [this.config.macAddress];
		this.log.debug("Initializing BLE");
		await this.ble.initialize();

		const desiredPeripherals = await this.ble.findDesiredPeripherals();
		this.log.debug(`Found ${desiredPeripherals.length} desired peripherals`);
		if (!desiredPeripherals.length) {
			this.log.error("Desired peripherals not found");
			throw new Error("Desired peripherals not found");
		}

		const peripheral = desiredPeripherals[0];

		const uuid = this.api.hap.uuid.generate(peripheral.id);
		const existingAccessory = this.accessories.find(
			(accessory) => accessory.UUID === uuid
		);

		if (existingAccessory) {
			this.log.info("Restoring accessory from cache");
			this.createNewCurtainAccessory(existingAccessory, peripheral);
		} else {
			this.log.info("Adding new accessory");
			const accessory = new this.api.platformAccessory(
				"SwitchBot Curtain 3",
				uuid
			);

			this.createNewCurtainAccessory(accessory, peripheral);

			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
				accessory,
			]);
		}
	}

	private createNewCurtainAccessory(
		accessory: PlatformAccessory,
		peripheral: Peripheral
	): SwitchBotCurtain3Accessory {
		return new SwitchBotCurtain3Accessory(
			this,
			accessory,
			peripheral,
			this.ble
		);
	}
}

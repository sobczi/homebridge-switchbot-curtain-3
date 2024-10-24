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
import { SwitchBotBLE, SwitchbotDevice, WoCurtain } from "node-switchbot";
import { SwitchBotCurtain3Accessory } from "./switchBotCurtain3Accessory.js";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SwitchBotCurtain3Platform implements DynamicPlatformPlugin {
	public readonly Service: typeof Service;
	public readonly Characteristic: typeof Characteristic;

	// this is used to track restored cached accessories
	public readonly accessories: PlatformAccessory[] = [];

	constructor(
		public readonly log: Logging,
		public readonly config: Curtain3Config,
		public readonly api: API
	) {
		this.Service = api.hap.Service;
		this.Characteristic = api.hap.Characteristic;

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

	/**
	 * This function is invoked when homebridge restores cached accessories from disk at startup.
	 * It should be used to set up event handlers for characteristics and update respective values.
	 */
	configureAccessory(accessory: PlatformAccessory) {
		this.log.info("Loading accessory from cache:", accessory.displayName);

		// add the restored accessory to the accessories cache, so we can track if it has already been registered
		this.accessories.push(accessory);
	}

	/**
	 * This is an example method showing how to register discovered accessories.
	 * Accessories must only be registered once, previously created accessories
	 * must not be registered again to prevent "duplicate UUID" errors.
	 */
	async discoverDevices() {
		const macAddress = this.config.macAddress;
		if (!macAddress) {
			return;
		}

		const ble = new SwitchBotBLE();
		const discovered: SwitchbotDevice[] = await ble.discover();
		const foundCurtain = discovered.find(
			(d) => d.deviceAddress.toLowerCase() === macAddress.toLowerCase()
		) as WoCurtain;

		if (!foundCurtain) {
			return;
		}

		const uuid = this.api.hap.uuid.generate(foundCurtain.id);
		const existingAccessory = this.accessories.find(
			(accessory) => accessory.UUID === uuid
		);
		if (existingAccessory) {
			this.log.info("Restoring accessory from cache");
			new SwitchBotCurtain3Accessory(this, existingAccessory, foundCurtain);
		} else {
			this.log.info("Adding new accessory");
			const accessory = new this.api.platformAccessory(
				"SwitchBot Curtain 3",
				uuid
			);

			// store a copy of the device object in the `accessory.context`
			// the `context` property can be used to store any data about the accessory you may need
			// accessory.context.device = foundCurtain;

			// create the accessory handler for the newly create accessory
			// this is imported from `platformAccessory.ts`
			new SwitchBotCurtain3Accessory(this, accessory, foundCurtain);

			// link the accessory to your platform
			this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
				accessory,
			]);
		}
	}
}

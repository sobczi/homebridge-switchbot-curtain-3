import { Advertisement, Peripheral } from "@stoprocent/noble";
import { Noble } from "./models/Noble";
import { EventEmitter } from "node:events";

export class BluetoothLowEnergy extends EventEmitter {
	noble: Noble = {} as any;
	onAd?: (ad: Advertisement) => Promise<void> | void;

	watchedMacAddresses: string[] = [];

	async startScanning(allowDuplicates?: boolean): Promise<void> {
		await this.noble.startScanningAsync([], allowDuplicates);
	}

	async stopScanning(): Promise<void> {
		this.noble.removeAllListeners("discover");
		await this.noble.stopScanningAsync();
	}

	watchAds(): void {
		this.startScanning(true);
		this.noble.on("discover", async (peripheral: Peripheral) => {
			peripheral.address = this.formatAddress(peripheral);
			if (this.watchedMacAddresses.includes(peripheral.address) && this.onAd) {
				this.onAd(peripheral.advertisement);
			}
		});
	}

	async initialize(): Promise<void> {
		this.noble = (await import("@stoprocent/noble")).default;

		return new Promise<void>((resolve, reject) => {
			this.noble?.once("stateChange", (state: string) => {
				switch (state) {
					case "unsupported":
					case "unauthorized":
					case "poweredOff":
						reject(
							new Error(`Failed to initialize the Noble object: ${state}`)
						);
						break;
					case "resetting":
					case "unknown":
						reject(new Error(`Adapter is not ready: ${state}`));
						break;
					case "poweredOn":
						resolve();
						break;
					default:
						reject(new Error(`Unknown state: ${state}`));
				}
			});
		});
	}

	async findDesiredPeripherals(): Promise<Peripheral[]> {
		const desiredPeripherals: Peripheral[] = [];

		let timer: NodeJS.Timeout;

		const startDiscovery = async (): Promise<void> => {
			this.noble.on("discover", async (p: Peripheral) => {
				if (this.watchedMacAddresses.length === desiredPeripherals.length) {
					await this.stopScanning();
					return;
				}

				p.address = this.formatAddress(p);

				if (this.watchedMacAddresses.includes(p.address)) {
					desiredPeripherals.push(p);
					console.log(
						`[${p.advertisement.localName || "Unknown"} @ ${
							p.address
						}] Peripheral found.`
					);
				}
			});
		};

		return new Promise<Peripheral[]>((resolve, reject) => {
			startDiscovery();
			this.noble.startScanningAsync().then(() => {
				timer = setTimeout(
					async () =>
						resolve(
							await this.stopScanning().then(() => {
								clearTimeout(timer);
								return desiredPeripherals;
							})
						),
					// TODO: Add custom TimeOut
					10000
				);
			});
		});
	}

	private formatAddress(peripheral: Peripheral): string {
		let address = peripheral.address || "";
		if (address === "") {
			const str =
				peripheral.advertisement.manufacturerData
					?.toString("hex")
					.slice(4, 16) || "";
			if (str !== "") {
				address = str.match(/.{1,2}/g)?.join(":") || "";
			}
		} else {
			address = address.replace(/-/g, ":");
		}
		return address.toUpperCase();
	}
}
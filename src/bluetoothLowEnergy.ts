import { Peripheral } from "@stoprocent/noble";
import { Noble } from "./models/Noble";

export class BluetoothLowEnergy {
	noble: Noble = {} as any;

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

	async findDesiredPeripherals(
		desiredMacAddresses: string[]
	): Promise<Peripheral[]> {
		const availablePeripherals: Peripheral[] = [];
		const desiredPeripherals: Peripheral[] = [];

		let timer: NodeJS.Timeout;

		const startDiscovery = async (): Promise<void> => {
			this.noble.on("discover", async (p: Peripheral) => {
				if (desiredMacAddresses.length === desiredPeripherals.length) {
					await this.noble.stopScanningAsync();
					return;
				}

				if (availablePeripherals.find((a) => a.uuid === p.uuid)) {
					return;
				}

				p.address = this.formatAddress(p);

				const isDesiredPeripheral = desiredMacAddresses.includes(p.address);
				if (isDesiredPeripheral) {
					desiredPeripherals.push(p);
				}

				console.log(
					`[${p.advertisement.localName || "Unknown"} @ ${p.address}] New ${
						isDesiredPeripheral ? "desired" : ""
					} peripheral found.`
				);
			});
		};

		const finishDiscovery = async (): Promise<Peripheral[]> => {
			clearTimeout(timer);
			this.noble.removeAllListeners("discover");
			await this.noble.stopScanningAsync();
			return desiredPeripherals;
		};

		return new Promise<Peripheral[]>((resolve, reject) => {
			startDiscovery();
			this.noble.startScanningAsync().then(() => {
				timer = setTimeout(async () => resolve(await finishDiscovery()), 10000);
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

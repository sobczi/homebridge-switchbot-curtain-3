import { Peripheral } from "@stoprocent/noble";
import events from "events";

export interface Noble {
	startScanning: (
		serviceUUIDs?: string[],
		allowDuplicates?: boolean,
		callback?: (error?: Error) => void
	) => void;

	startScanningAsync: (
		serviceUUIDs?: string[],
		allowDuplicates?: boolean
	) => Promise<void>;

	stopScanning: (callback?: () => void) => void;
	stopScanningAsync: () => Promise<void>;

	connect: (
		peripheralUuid: string,
		options?: object,
		callback?: (error: Error | undefined, peripheral: Peripheral) => void
	) => void;

	connectAsync: (
		peripheralUuid: string,
		options?: object
	) => Promise<Peripheral>;

	cancelConnect: (peripheralUuid: string, options?: object) => void;
	reset: () => void;

	setAddress: (address: string) => void;

	on: (
		event: "stateChange" | "scanStart" | "scanStop" | "discover" | string,
		listener: Function
	) => events.EventEmitter;

	once: (
		event: "stateChange" | "scanStart" | "scanStop" | "discover" | string,
		listener: Function
	) => events.EventEmitter;

	removeListener: (
		event: "stateChange" | "scanStart" | "scanStop" | "discover" | string,
		listener: Function
	) => events.EventEmitter;

	removeAllListeners: (event?: string) => events.EventEmitter;
}

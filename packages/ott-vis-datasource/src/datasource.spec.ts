import type { DataQueryRequest, DataSourceInstanceSettings } from "@grafana/data";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Observable } from "rxjs";
import type { MyDataSourceOptions, MyQuery } from "./types";

// Load the consumer after registering the mock; this does not depend on SWC hoisting imported jest.
jest.doMock("@grafana/runtime", () => ({ getBackendSrv: jest.fn() }));
const { DataSource } = jest.requireActual<typeof import("./datasource")>("./datasource");
const { getBackendSrv } = jest.requireMock<typeof import("@grafana/runtime")>("@grafana/runtime");

class MockSocket extends EventTarget {
	static instances: MockSocket[] = [];
	close = jest.fn();

	constructor(public url: string) {
		super();
		MockSocket.instances.push(this);
	}
}

const settings = {
	jsonData: { baseUrl: "https://collector.example.com" },
} as DataSourceInstanceSettings<MyDataSourceOptions>;
const request = (stream: boolean): DataQueryRequest<MyQuery> =>
	({ targets: [{ refId: "A", constant: 1, stream }] }) as DataQueryRequest<MyQuery>;

describe("DataSource query lifecycle", () => {
	const originalSocket = window.WebSocket;

	beforeEach(() => {
		jest.useFakeTimers();
		MockSocket.instances = [];
		window.WebSocket = MockSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
		jest.restoreAllMocks();
		window.WebSocket = originalSocket;
	});

	it("cancels a queued reconnect when the query unsubscribes", () => {
		const subscription = new DataSource(settings).query(request(true)).subscribe();
		MockSocket.instances[0].dispatchEvent(new CloseEvent("close", { code: 1006 }));
		subscription.unsubscribe();
		jest.advanceTimersByTime(2000);
		expect(MockSocket.instances).toHaveLength(1);
		expect(MockSocket.instances[0].close).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it("reconnects a live query and removes the unloading listener on teardown", () => {
		const removeListener = jest.spyOn(window, "removeEventListener");
		const subscription = new DataSource(settings).query(request(true)).subscribe();
		MockSocket.instances[0].dispatchEvent(new CloseEvent("close", { code: 1006 }));
		jest.advanceTimersByTime(1000);
		expect(MockSocket.instances).toHaveLength(2);
		expect(MockSocket.instances[1].url).toBe("wss://collector.example.com/state/stream");
		subscription.unsubscribe();
		expect(MockSocket.instances[1].close).toHaveBeenCalledTimes(1);
		expect(removeListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
	});

	it("stops the stream when a malformed event arrives", () => {
		const error = jest.fn();
		const subscription = new DataSource(settings).query(request(true)).subscribe({ error });
		MockSocket.instances[0].dispatchEvent(
			new MessageEvent("message", { data: "invalid JSON" }),
		);
		expect(error).toHaveBeenCalledWith(expect.any(SyntaxError));
		expect(MockSocket.instances[0].close).toHaveBeenCalledTimes(1);
		expect(subscription.closed).toBe(true);
	});

	it("does not open a connection for hidden targets", () => {
		const hiddenRequest = request(true);
		hiddenRequest.targets[0].hide = true;
		new DataSource(settings).query(hiddenRequest).subscribe();
		expect(MockSocket.instances).toHaveLength(0);
	});

	it("cancels the HTTP request with its query subscription", () => {
		const cancel = jest.fn();
		jest.mocked(getBackendSrv).mockReturnValue({
			fetch: () => new Observable(() => cancel),
		} as unknown as ReturnType<typeof getBackendSrv>);
		const subscription = new DataSource(settings).query(request(false)).subscribe();
		subscription.unsubscribe();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("propagates HTTP failures to the query", () => {
		const failure = new Error("collector unavailable");
		jest.mocked(getBackendSrv).mockReturnValue({
			fetch: () => new Observable(subscriber => subscriber.error(failure)),
		} as unknown as ReturnType<typeof getBackendSrv>);
		const error = jest.fn();
		const subscription = new DataSource(settings).query(request(false)).subscribe({ error });
		expect(error).toHaveBeenCalledWith(failure);
		subscription.unsubscribe();
	});
});

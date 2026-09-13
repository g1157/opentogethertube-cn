import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import { i18n } from "@/i18n";
import { ToastStyle } from "@/models/toast";

const baseURL = `${(import.meta.env.OTT_BASE_URL as string | undefined) ?? ""}/api`;

export const API = axios.create({
	baseURL,
	transformRequest: [
		(data, headers) => {
			const token = window.localStorage.getItem("token");
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
			return JSON.stringify(data);
		},
	],
	headers: {
		"Content-Type": "application/json",
	},
});

/** Logging in or registering can legitimately return 401; those are not expired sessions. */
const AUTH_ENDPOINTS = ["/user/login", "/user/register", "/auth/"];

interface RetriableConfig extends AxiosRequestConfig {
	_ottRetried?: boolean;
}

async function refreshAuthToken(): Promise<string | null> {
	try {
		// A bare client: this request must not run through the interceptor below.
		const response = await axios.get<{ token?: unknown }>(`${baseURL}/auth/grant`);
		const token = response.data?.token;
		if (typeof token === "string" && token.length > 0) {
			window.localStorage.setItem("token", token);
			return token;
		}
	} catch (error) {
		console.warn("Could not refresh the auth token", error);
	}
	return null;
}

/**
 * A 401 usually means the stored token expired. Refresh it once and replay the request;
 * if that is not possible, say so without navigating away from what the user was doing.
 */
API.interceptors.response.use(
	response => response,
	async (error: AxiosError) => {
		const config = error.config as RetriableConfig | undefined;
		const url = config?.url ?? "";
		const isAuthEndpoint = AUTH_ENDPOINTS.some(endpoint => url.startsWith(endpoint));
		if (error.response?.status !== 401 || !config || config._ottRetried || isAuthEndpoint) {
			return Promise.reject(error);
		}
		config._ottRetried = true;
		const token = await refreshAuthToken();
		if (token === null) {
			const { store } = await import("@/store");
			store.commit("toast/ADD_TOAST", {
				style: ToastStyle.Error,
				content: i18n.global.t("errors.session-expired"),
				duration: 6000,
			});
			return Promise.reject(error);
		}
		config.headers = {
			...config.headers,
			Authorization: `Bearer ${token}`,
		} as AxiosRequestConfig["headers"];
		// The body was already serialized by the first attempt.
		config.transformRequest = [data => data];
		return API.request(config);
	},
);

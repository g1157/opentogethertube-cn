// Lightweight WebGL2 contrast-adaptive sharpening used as the cheap upscaling tier.
export interface UpscaleRenderer {
	stop(): void;
}

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	// Video frames upload with the first row at v=0; flip Y so the picture is upright.
	vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
	gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uAmount;
in vec2 vUv;
out vec4 outColor;
void main() {
	vec3 c = texture(uTexture, vUv).rgb;
	vec3 n = texture(uTexture, vUv + vec2(0.0, -uTexel.y)).rgb;
	vec3 s = texture(uTexture, vUv + vec2(0.0, uTexel.y)).rgb;
	vec3 w = texture(uTexture, vUv + vec2(-uTexel.x, 0.0)).rgb;
	vec3 e = texture(uTexture, vUv + vec2(uTexel.x, 0.0)).rgb;
	vec3 blur = (n + s + w + e) * 0.25;
	// Clamp the sharpened result to the local neighborhood so edges never halo.
	vec3 mn = min(min(min(n, s), min(w, e)), c);
	vec3 mx = max(max(max(n, s), max(w, e)), c);
	outColor = vec4(clamp(c + (c - blur) * uAmount, mn, mx), 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) {
		throw new Error("Unable to create shader");
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
	}
	return shader;
}

export function startSharpenRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): UpscaleRenderer {
	const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
	if (!gl) {
		throw new Error("WebGL2 unavailable");
	}
	const program = gl.createProgram();
	if (!program) {
		throw new Error("Unable to create program");
	}
	gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
	gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
	}
	gl.useProgram(program);

	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	const aPos = gl.getAttribLocation(program, "aPos");
	gl.enableVertexAttribArray(aPos);
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

	gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
	gl.uniform1f(gl.getUniformLocation(program, "uAmount"), 0.75);
	gl.uniform2f(
		gl.getUniformLocation(program, "uTexel"),
		1 / Math.max(1, video.videoWidth),
		1 / Math.max(1, video.videoHeight),
	);

	let frameRequest = 0;
	let stopped = false;

	const frame = () => {
		if (stopped) {
			return;
		}
		if (!video.paused && video.readyState >= video.HAVE_CURRENT_DATA) {
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
			gl.uniform2f(
				gl.getUniformLocation(program, "uTexel"),
				1 / Math.max(1, video.videoWidth),
				1 / Math.max(1, video.videoHeight),
			);
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}
		frameRequest = video.requestVideoFrameCallback(frame);
	};
	frameRequest = video.requestVideoFrameCallback(frame);

	return {
		stop() {
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		},
	};
}

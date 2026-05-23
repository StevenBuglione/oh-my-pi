import { type ChatGptJsonEnvelope, ChatGptJsonEnvelopeSchema } from "./types";

export interface JsonEnvelopeValidation {
	ok: boolean;
	value?: ChatGptJsonEnvelope;
	error?: string;
}

export function parseChatGptJsonEnvelope(raw: string): JsonEnvelopeValidation {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const result = ChatGptJsonEnvelopeSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, error: result.error.message };
	}
	return { ok: true, value: result.data };
}

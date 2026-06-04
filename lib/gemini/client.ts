import { GoogleGenAI } from "@google/genai";

let _client: GoogleGenAI | null = null;

export function gemini(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in environment.");
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export const MODEL_DESCRIBE = "gemini-3.5-flash";
export const MODEL_MATCH = "gemini-3.1-pro-preview";

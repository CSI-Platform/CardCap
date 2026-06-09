import { normalizeExtraction } from '../shared/extraction'
import type { ContactDraft, ExtractionResult } from '../shared/types'

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'company',
    'role',
    'emails',
    'phones',
    'website',
    'address',
    'tags',
    'notes',
    'confidence',
    'needs_review',
  ],
  properties: {
    name: { type: 'string' },
    company: { type: 'string' },
    role: { type: 'string' },
    emails: { type: 'array', items: { type: 'string' } },
    phones: { type: 'array', items: { type: 'string' } },
    website: { type: 'string' },
    address: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    confidence: { type: 'number' },
    needs_review: { type: 'boolean' },
  },
}

type ExtractOptions = {
  fileName: string
  bytes: ArrayBuffer
  contentType: string
  env: Env
}

export async function extractCard(options: ExtractOptions): Promise<{
  draft: ContactDraft
  raw: ExtractionResult
  mode: 'mock' | 'openai'
}> {
  const useOpenAi = envValue(options.env, 'AI_EXTRACTOR') === 'openai' && Boolean(envValue(options.env, 'OPENAI_API_KEY'))
  if (!useOpenAi) {
    const raw = mockExtract(options.fileName)
    return { draft: normalizeExtraction(raw), raw, mode: 'mock' }
  }

  const raw = await openAiExtract(options)
  return { draft: normalizeExtraction(raw), raw, mode: 'openai' }
}

function mockExtract(fileName: string): ExtractionResult {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    name: base && !/^img\s*\d+/i.test(base) ? titleCase(base) : 'Review Contact',
    company: '',
    role: '',
    emails: [],
    phones: [],
    website: '',
    address: '',
    tags: ['Needs review'],
    notes: 'Mock extraction created this draft. Add an OpenAI API key and set AI_EXTRACTOR=openai for live card extraction.',
    confidence: 0.35,
    needs_review: true,
  }
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

async function openAiExtract(options: ExtractOptions): Promise<ExtractionResult> {
  const imageBase64 = arrayBufferToBase64(options.bytes)
  const apiKey = envValue(options.env, 'OPENAI_API_KEY')
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: envValue(options.env, 'OPENAI_MODEL') || 'gpt-5-mini',
      reasoning: { effort: 'none' },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Extract business card contact data for a CRM. Return only the fields in the schema. ' +
                'Use the prominent human name as name. Do not put a person name in company. ' +
                'Use the brokerage, agency, employer, brand, or organization logo text as company. ' +
                'Use the title under or near the person name as role. Preserve phone numbers, emails, websites, and addresses exactly as printed. ' +
                'Use tags for visible credentials, specialties, industries, license badges, and card context. ' +
                'Use empty strings or empty arrays when a field is not visible. Mark needs_review true for uncertain or conflicting values.',
            },
            {
              type: 'input_image',
              image_url: `data:${options.contentType};base64,${imageBase64}`,
              detail: 'high',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'business_card_contact',
          strict: true,
          schema: extractionSchema,
        },
      },
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`OpenAI extraction failed: ${response.status} ${message}`)
  }

  const payload = (await response.json()) as {
    output_text?: string
    output?: Array<{ content?: Array<{ text?: string }> }>
  }
  const text =
    payload.output_text ||
    payload.output?.flatMap((item) => item.content || []).find((content) => content.text)?.text ||
    '{}'
  return JSON.parse(text) as ExtractionResult
}

function envValue(env: Env, key: string): string {
  const values = env as unknown as Record<string, unknown>
  const value = values[key]
  return typeof value === 'string' ? value : ''
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

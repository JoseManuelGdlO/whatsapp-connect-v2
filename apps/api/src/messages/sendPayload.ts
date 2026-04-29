import { z } from 'zod';

const textBodySchema = z.object({
  to: z.string().min(3),
  type: z.literal('text'),
  text: z.string().min(1),
  isTest: z.boolean().optional()
});

const imageBodySchema = z.object({
  to: z.string().min(3),
  type: z.literal('image'),
  imageUrl: z.string().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'imageUrl must use http or https'
  }),
  caption: z.string().max(1024).optional(),
  isTest: z.boolean().optional()
});

const sendMessageDiscriminatedSchema = z.discriminatedUnion('type', [textBodySchema, imageBodySchema]);
export const sendMessageBodySchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('type' in raw)) {
    return { ...(raw as Record<string, unknown>), type: 'text' };
  }
  return raw;
}, sendMessageDiscriminatedSchema);

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

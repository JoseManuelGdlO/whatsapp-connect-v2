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

const documentBodySchema = z.object({
  to: z.string().min(3),
  type: z.literal('document'),
  documentUrl: z.string().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'documentUrl must use http or https'
  }),
  fileName: z
    .string()
    .optional()
    .refine((value) => !value || /\.pdf$/i.test(value), { message: 'fileName must end with .pdf' }),
  caption: z.string().max(1024).optional(),
  isTest: z.boolean().optional()
});

const statusImageBodySchema = z.object({
  type: z.literal('status_image'),
  imageUrl: z.string().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'imageUrl must use http or https'
  }),
  caption: z.string().max(1024).optional(),
  statusJidList: z.array(z.string().min(3)).min(1).max(500),
  isTest: z.boolean().optional()
});

const sendMessageDiscriminatedSchema = z.discriminatedUnion('type', [
  textBodySchema,
  imageBodySchema,
  documentBodySchema,
  statusImageBodySchema
]);
export const sendMessageBodySchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('type' in raw)) {
    return { ...(raw as Record<string, unknown>), type: 'text' };
  }
  return raw;
}, sendMessageDiscriminatedSchema);

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

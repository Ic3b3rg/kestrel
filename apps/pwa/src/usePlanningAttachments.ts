import { useRef, useState } from "react";
import {
  PlanningAttachmentSchema,
  PLANNING_ATTACHMENT_LIMIT,
  PLANNING_IMAGE_MAX_BYTES,
  PLANNING_TEXT_MAX_BYTES,
  type PlanningAttachment,
} from "@kestrel/contracts";

async function readFile(file: File): Promise<PlanningAttachment> {
  const image = file.type.startsWith("image/");
  if (image && !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose PNG, JPEG or WebP images.");
  if (
    !image &&
    !file.type.startsWith("text/") &&
    !/\.(txt|md|mdx|json|csv|tsv|log|ya?ml|xml|html|css|[cm]?[jt]sx?|py|rs|go|sh|sql|toml|ini|conf)$/iu.test(
      file.name,
    )
  )
    throw new Error(
      "Choose an image or UTF-8 text file. PDF and Office documents are not supported.",
    );
  if (file.size > (image ? PLANNING_IMAGE_MAX_BYTES : PLANNING_TEXT_MAX_BYTES))
    throw new Error(`${file.name} is too large. Images: 2 MB; text files: 64 KB.`);
  const bytes = await file.arrayBuffer();
  if (!image) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${file.name} must contain UTF-8 text.`);
    }
    const parsed = PlanningAttachmentSchema.safeParse({ kind: "text", name: file.name, text });
    if (!parsed.success)
      throw new Error(`${file.name} contains unsupported binary content or an invalid filename.`);
    return parsed.data;
  }
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return PlanningAttachmentSchema.parse({
    kind: "image",
    name: file.name,
    mediaType: file.type,
    data: btoa(binary),
  });
}

export function usePlanningAttachments(onChange?: (files: PlanningAttachment[]) => void) {
  const [files, setFiles] = useState<PlanningAttachment[]>([]);
  const current = useRef(files);
  const reading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (next: PlanningAttachment[]) => {
    current.current = next;
    setFiles(next);
    onChange?.(next);
  };
  const add = async (incoming: File[]) => {
    if (reading.current || incoming.length === 0) return;
    setError(null);
    if (current.current.length + incoming.length > PLANNING_ATTACHMENT_LIMIT) {
      setError("Attach up to four files per message.");
      return;
    }
    reading.current = true;
    setBusy(true);
    try {
      update([...current.current, ...(await Promise.all(incoming.map(readFile)))]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The attachment could not be read.");
    } finally {
      reading.current = false;
      setBusy(false);
    }
  };
  return {
    files,
    busy,
    error,
    add,
    remove: (index: number) => {
      update(current.current.filter((_, i) => i !== index));
      setError(null);
    },
    clear: () => {
      update([]);
      setError(null);
    },
  };
}
export type PlanningAttachmentsDraft = ReturnType<typeof usePlanningAttachments>;

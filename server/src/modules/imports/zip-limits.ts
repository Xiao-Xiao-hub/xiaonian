import JSZip from "jszip";
import { ResourceLimitError } from "../../shared/isolated-worker.js";

const MAX_ENTRY = 16 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
// Inspect before XML parsing and before mammoth's fallback, and count actual
// inflated bytes as ZIP directory sizes are untrusted.
export async function boundedDocx(data: Buffer, fallback = false) {
  if (data.length > 10 * 1024 * 1024) throw new ResourceLimitError("file_size");
  const zip = await JSZip.loadAsync(data);
  const files = Object.values(zip.files).filter((file) => !file.dir);
  if (files.length > 256) throw new ResourceLimitError("zip_entries");
  let total = 0;
  for (const file of files) {
    // The primary reader only opens document.xml. The fallback receives a
    // package containing XML parts only, so relationship targets cannot make
    // mammoth inflate uninspected media. Raw-text extraction needs no images.
    const xml = /\.(?:xml|rels)$/i.test(file.name);
    if (fallback && !xml) zip.remove(file.name);
    if (fallback ? !xml : file.name !== "word/document.xml") continue;
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (file as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
      }).internalStream("uint8array");
      stream.on("data", (chunk: Uint8Array) => {
        size += chunk.length;
        total += chunk.length;
        if (size > MAX_ENTRY || total > MAX_TOTAL) {
          stream.pause();
          reject(new ResourceLimitError("zip_output"));
        }
      });
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.resume();
    });
  }
  return zip;
}

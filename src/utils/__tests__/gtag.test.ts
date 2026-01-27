import { describe, it, expect, vi } from "vitest";
import { sendDownloadEvent } from "../gtag";

describe("gtag", () => {
  it("sends download event when gtag is present", () => {
    const gtag = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).gtag = gtag;

    sendDownloadEvent({
      link: "test-link",
      os: "windows",
      arch: "x64",
      pkg_type: "jdk",
      version: "21",
      vendor: "adoptium",
    });

    expect(gtag).toHaveBeenCalledWith("event", "download", {
      event_category: "download",
      link: "test-link",
      event_label: "windows-x64-jdk",
      java_version: "21",
      vendor: "adoptium",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).gtag;
  });

  it("does nothing when gtag is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).gtag;
    
    // Should not throw
    sendDownloadEvent({
      link: "test-link",
      os: "windows",
      arch: "x64",
      pkg_type: "jdk",
      version: "21",
      vendor: "adoptium",
    });
  });
});

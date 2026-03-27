import { useEffect, useRef, useState } from "preact/hooks";

export function useCopyFeedback() {
  const copyFeedbackTimeoutRef = useRef<number | undefined>(undefined);
  const [copyFeedbackKey, setCopyFeedbackKey] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current !== undefined) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const showCopyFeedback = (key: string) => {
    setCopyFeedbackKey(key);
    if (copyFeedbackTimeoutRef.current !== undefined) {
      window.clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = window.setTimeout(() => {
      setCopyFeedbackKey((current) => (current === key ? null : current));
      copyFeedbackTimeoutRef.current = undefined;
    }, 2000);
  };

  return {
    copyFeedbackKey,
    showCopyFeedback
  };
}

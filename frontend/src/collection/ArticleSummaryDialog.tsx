import { useState } from "react";
import type { ArticleJobSnapshot } from "@dailybrief/shared";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";

export function ArticleSummaryDialog({
  articleTitle,
  summary,
}: {
  articleTitle: string;
  summary: NonNullable<ArticleJobSnapshot["summary"]>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Résumé IA"
      description={articleTitle}
      trigger={
        <Button variant="outline" size="sm" aria-label={`Voir le résumé de ${articleTitle}`}>
          Voir le résumé
        </Button>
      }
    >
      <div className="space-y-5 break-words">
        <h2 className="text-lg font-semibold">{summary.title}</h2>
        <p className="whitespace-pre-line leading-relaxed">{summary.summary}</p>
        {!!summary.keyPoints.length && (
          <div className="space-y-3">
            <h3 className="font-semibold">Points clés</h3>
            <ul className="list-disc space-y-2 pl-5">
              {summary.keyPoints.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

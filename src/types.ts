export interface Source {
    id: number;
    name: string;
    type: "rss" | "gdelt";
    url: string;
    enabled: number;
    interval_minutes: number;
    last_fetched_at: number | null;
    last_error: string | null;
    articles_total: number;
}

export interface Category {
    id: number;
    name: string;
    description: string;
    examples: string;
    threshold: number;
    enabled: number;
}

export interface RawArticle {
    title: string;
    url: string;
    summary: string;
    publishedAt: number;
}
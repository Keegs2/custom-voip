import { Button } from './Button';

interface PaginationProps {
  shown: number;
  total: number;
  onLoadMore: () => void;
  loading?: boolean;
}

export function Pagination({ shown, total, onLoadMore, loading = false }: PaginationProps) {
  const hasMore = shown < total;

  return (
    <div className="flex items-center justify-between mt-4 text-[0.82rem] text-[#718096]">
      <span>
        Showing <span className="text-[#e2e8f0] font-semibold">{shown}</span> of{' '}
        <span className="text-[#e2e8f0] font-semibold">{total}</span>
      </span>
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          loading={loading}
          onClick={onLoadMore}
        >
          Load More
        </Button>
      )}
    </div>
  );
}

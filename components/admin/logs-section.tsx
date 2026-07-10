"use client";

import { RequestLogsWorkbench } from "@/components/workspace/request-logs-workbench";
import {
  adminErrorMessage,
  getRequestLogDetail,
  getRequestLogsPage,
  type RequestLogsPage,
} from "@/lib/admin-api";

export function LogsSection({
  initialRequestLogsPage,
  onLoaded,
}: {
  initialRequestLogsPage: RequestLogsPage;
  onLoaded: (page: RequestLogsPage) => void;
}) {
  return (
    <RequestLogsWorkbench
      detailTenantColumn
      errorMessage={adminErrorMessage}
      initialPage={initialRequestLogsPage}
      loadDetail={getRequestLogDetail}
      loadPage={getRequestLogsPage}
      onLoaded={onLoaded}
    />
  );
}

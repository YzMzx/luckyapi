import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; title?: string };
type State = { error: Error | null };

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page render failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <section className="w-full max-w-lg rounded-2xl border border-[#EF5459]/30 bg-[#101d2b] p-8 text-center shadow-2xl">
          <h1 className="text-2xl font-black text-[#fce1b6]">{this.props.title ?? "页面加载失败"}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">页面遇到了临时错误，请刷新后重试。若仍然失败，可先返回首页。</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-[#FFB700] px-5 py-2.5 text-sm font-black text-[#162638]">刷新重试</button>
            <a href="/" className="rounded-lg border border-border px-5 py-2.5 text-sm font-bold text-[#fce1b6]">返回首页</a>
          </div>
        </section>
      </main>
    );
  }
}

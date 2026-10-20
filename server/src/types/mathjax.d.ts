// The node entry of the `mathjax` package ships without type declarations; only
// the parts used by the formula renderer are described here.
declare module "mathjax" {
  type Adaptor = {
    serializeXML(node: unknown): string;
    firstChild(node: unknown): unknown;
  };
  const MathJax: {
    init(config: Record<string, unknown>): Promise<unknown>;
    tex2svgPromise(
      tex: string,
      // Sizes in px; the container width is where displayed formulas break.
      options: {
        display: boolean;
        em?: number;
        ex?: number;
        containerWidth?: number;
      },
    ): Promise<unknown>;
    startup: { adaptor: Adaptor };
  };
  export default MathJax;
}

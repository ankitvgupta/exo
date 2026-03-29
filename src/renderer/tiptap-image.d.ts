export {};

declare module "@tiptap/extension-image" {
  import { Node } from "@tiptap/core";

  interface ImageOptions {
    inline: boolean;
    allowBase64: boolean;
    HTMLAttributes: Record<string, string>;
  }

  const Image: Node<ImageOptions>;
  export default Image;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    image: {
      setImage: (options: {
        src: string;
        alt?: string;
        title?: string;
      }) => ReturnType;
    };
  }
}

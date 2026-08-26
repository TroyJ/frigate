import { useEffect, useRef, useState } from "react";

const useImageLoaded = (): [
  React.RefObject<HTMLImageElement>,
  boolean,
  () => void,
] => {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  const onLoad = () => {
    setLoaded(true);
  };

  // Guards the cached-image race: if the <img> was already complete before React attached
  // the onLoad handler, the load event never arrives. Run once on mount only — without a
  // dependency array this DOM read ran on every render of every card (fork: P7).
  useEffect(() => {
    if (ref.current && ref.current?.complete) {
      onLoad();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, loaded, onLoad];
};

export default useImageLoaded;

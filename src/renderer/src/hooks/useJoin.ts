import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process join pushes for the lifetime of the app, then asks for the
 * current state so a window opened mid-session starts in sync. */
export function useJoinEvents(): void {
  const receiveJoinState = useAppStore((store) => store.receiveJoinState)

  useEffect(() => {
    let disposed = false
    let pushed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed. Pushes
    // carry no sequence number, so a snapshot that lands after one is dropped rather than
    // risk rolling the state back.
    const unsubscribe = window.plexo.onJoinStateChanged((state) => {
      pushed = true
      receiveJoinState(state)
    })

    void window.plexo
      .getJoinState()
      .then((snapshot) => {
        if (!disposed && !pushed) receiveJoinState(snapshot)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveJoinState])
}

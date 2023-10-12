import { useRef } from 'react'
import PropTypes from 'prop-types'
import { useDragLayer } from 'react-dnd'
import classNames from 'classnames'

// a custom component rendered on top of a draggable area that renders the
// dragged item. See
// https://react-dnd.github.io/react-dnd/examples/drag-around/custom-drag-layer
// for more details.
// Also used to display a container border when hovered.
function FileTreeDraggablePreviewLayer({ isOver }) {
  const { isDragging, item, clientOffset } = useDragLayer(monitor => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    clientOffset: monitor.getClientOffset(),
  }))
  const ref = useRef()

  return (
    <div
      ref={ref}
      className={classNames('dnd-draggable-preview-layer', {
        'dnd-droppable-hover': isOver,
      })}
    >
      {isDragging && item?.title && (
        <div
          style={getItemStyle(
            clientOffset,
            ref.current?.getBoundingClientRect()
          )}
        >
          <DraggablePreviewItem title={item.title} />
        </div>
      )}
    </div>
  )
}

FileTreeDraggablePreviewLayer.propTypes = {
  isOver: PropTypes.bool.isRequired,
}

function DraggablePreviewItem({ title }) {
  return <div className="dnd-draggable-preview-item">{title}</div>
}

DraggablePreviewItem.propTypes = {
  title: PropTypes.string.isRequired,
}

// makes the preview item follow the cursor.
// See https://react-dnd.github.io/react-dnd/docs/api/drag-layer-monitor
function getItemStyle(clientOffset, containerOffset) {
  if (!containerOffset || !clientOffset) {
    return {
      display: 'none',
    }
  }
  const { x: containerX, y: containerY } = containerOffset
  const { x: clientX, y: clientY } = clientOffset
  const posX = clientX - containerX - 15
  const posY = clientY - containerY - 15
  const transform = `translate(${posX}px, ${posY}px)`
  return {
    transform,
    WebkitTransform: transform,
  }
}

export default FileTreeDraggablePreviewLayer

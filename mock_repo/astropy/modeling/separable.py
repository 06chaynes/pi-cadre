# Separability matrix computation
import numpy as np
from .core import Model, CompoundModel

def _coord_matrix(model, pos, noutp):
    return np.ones((noutp, model.n_inputs), dtype=bool)

def _cstack(left, right):
    noutp = left.shape[0] + right.shape[0]
    cleft = np.zeros((noutp, left.shape[1]), dtype=bool)
    cleft[:left.shape[0], :] = left

    if isinstance(right, Model):
        cright = _coord_matrix(right, 'right', noutp)
    else:
        cright = np.zeros((noutp, right.shape[1]), dtype=bool)
        cright[-right.shape[0]:, -right.shape[1]:] = 1

    return np.hstack([cleft, cright])

def _separable(transform):
    if isinstance(transform, CompoundModel):
        if transform.op == '&':
            return _cstack(_separable(transform.left), _separable(transform.right))
    elif isinstance(transform, Model):
        return np.ones((transform.n_outputs, transform.n_inputs), dtype=bool)
    return np.eye(1, dtype=bool)

def separability_matrix(transform):
    """Compute the separability matrix for a given model."""
    if transform.n_inputs == 1 and transform.n_outputs == 1:
        return np.array([[True]])
    return _separable(transform)

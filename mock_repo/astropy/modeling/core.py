# Core Model definitions
import numpy as np

class Model:
    def __init__(self, n_inputs=1, n_outputs=1):
        self.n_inputs = n_inputs
        self.n_outputs = n_outputs
        self._separable = True

    def __and__(self, other):
        return CompoundModel('&', self, other)

class CompoundModel(Model):
    def __init__(self, op, left, right):
        super().__init__(left.n_inputs + right.n_inputs, left.n_outputs + right.n_outputs)
        self.op = op
        self.left = left
        self.right = right

class Linear1D(Model):
    def __init__(self, slope=1):
        super().__init__(1, 1)
        self.slope = slope

class Pix2Sky_TAN(Model):
    def __init__(self):
        super().__init__(2, 2)

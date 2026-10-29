import numpy as np
from astropy.modeling.core import Linear1D, Pix2Sky_TAN
from astropy.modeling.separable import separability_matrix

def test_nested_compound_models():
    cm = Linear1D(10) & Linear1D(5)
    nested = Pix2Sky_TAN() & cm
    matrix = separability_matrix(nested)
    
    # Expected: The two Linear1D models in cm must remain separable (independent outputs)
    # The bottom-right 2x2 submatrix must be identity (diagonal True)
    expected_bottom_right = np.array([[True, False], [False, True]])
    actual_bottom_right = matrix[2:, 2:]
    
    assert np.array_equal(actual_bottom_right, expected_bottom_right), f"Expected identity diagonal but got:\n{actual_bottom_right}"
    print("TEST PASSED: Separability matrix is correctly computed for nested CompoundModels!")

if __name__ == '__main__':
    test_nested_compound_models()
